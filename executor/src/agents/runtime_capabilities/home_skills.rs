// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use super::{read_skill_manifest, write_json_file, write_skill_manifest};

const NATIVE_SYSTEM_SKILLS: &str = ".system";

/// The Home lease excludes readers while the complete skill selection is switched.
pub(super) struct HomeSkillsStage {
    home: PathBuf,
    staging: tempfile::TempDir,
}

impl HomeSkillsStage {
    pub(super) fn prepare(home: &Path) -> Result<Self, String> {
        fs::create_dir_all(home).map_err(|error| error.to_string())?;
        recover(home)?;
        // Same depth as home/skills keeps relative package links valid after rename.
        let staging = tempfile::Builder::new()
            .prefix(".skills-")
            .tempdir_in(home)
            .map_err(|error| error.to_string())?;
        write_skill_manifest(staging.path(), &Default::default())?;
        Ok(Self {
            home: home.to_owned(),
            staging,
        })
    }

    pub(super) fn skills_dir(&self) -> PathBuf {
        self.staging.path().to_owned()
    }

    pub(super) fn reuse(&self, names: &[String]) -> Result<(), String> {
        if names.iter().any(|name| name == NATIVE_SYSTEM_SKILLS) {
            return Err("The .system Skills directory is reserved for the native engine".into());
        }
        let current = self.home.join("skills");
        if !current.exists() {
            return Ok(());
        }
        check_managed_target(&self.home, &current)?;
        let old = read_skill_manifest(&current)?;
        let mut records = std::collections::BTreeMap::new();
        for name in names {
            crate::services::skill_deployer::validate_skill_name(name)?;
            let Some(record) = old.get(name) else {
                continue;
            };
            let source = current.join(name);
            if !source.join("SKILL.md").is_file() {
                continue;
            }
            let target = self.staging.path().join(name);
            if source.is_symlink() {
                crate::services::workbench::link_package(&source, &target)?;
            } else {
                fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                super::copy_skill_directory(&source, &target)?;
            }
            records.insert(name.clone(), record.clone());
        }
        write_skill_manifest(self.staging.path(), &records)
    }

    pub(super) fn activate(self) -> Result<(), String> {
        reject_staged_system_skills(self.staging.path())?;
        let target = self.home.join("skills");
        check_managed_target(&self.home, &target)?;
        validate_selection(self.staging.path())?;
        let records = read_skill_manifest(self.staging.path())?;
        let stage = self
            .staging
            .path()
            .file_name()
            .ok_or("Invalid skill staging path")?
            .to_string_lossy()
            .into_owned();
        let pending = json!({
            "schema_version": 2, "stage": stage,
            "had_target": target.exists() || target.is_symlink(),
            "had_system_skills": target.join(NATIVE_SYSTEM_SKILLS).exists(),
            "skills": records, "entries": selection_entries(self.staging.path())?,
        });
        // Retain the staged selection if publication is interrupted.
        let _ = self.staging.keep();
        write_json_file(&self.home.join("capabilities.pending.json"), &pending)?;
        recover(&self.home)
    }
}

fn check_managed_target(home: &Path, target: &Path) -> Result<(), String> {
    if !target.exists() && !target.is_symlink() {
        return Ok(());
    }
    let marker: Value = serde_json::from_slice(
        &fs::read(home.join("capabilities.json"))
            .map_err(|_| "Refusing to replace unmanaged agent Skills directory")?,
    )
    .map_err(|error| error.to_string())?;
    let current = marker.get("current").and_then(Value::as_str);
    if target.is_symlink() {
        let resolved = fs::canonicalize(target).map_err(|error| error.to_string())?;
        let legacy = fs::canonicalize(home.join("capability-snapshots"))
            .map_err(|error| error.to_string())?;
        if !resolved.starts_with(legacy) || current.map(Path::new) != Some(resolved.as_path()) {
            return Err("Agent Skills link does not match its managed entry".into());
        }
    } else if !target.is_dir() || current != Some("skills") {
        return Err("Refusing to replace unmanaged agent Skills directory".into());
    } else if marker["entries"] != json!(selection_entries(target)?) {
        return Err("Agent Skills directory contains unmanaged entries".into());
    }
    validate_selection(target)
}

fn validate_selection(skills: &Path) -> Result<(), String> {
    for entry in fs::read_dir(skills).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_name() == NATIVE_SYSTEM_SKILLS {
            if !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                return Err("Native system Skills must be a real directory".into());
            }
            continue;
        }
        if entry.file_name() == super::SKILL_MANIFEST_FILE && entry.path().is_file() {
            continue;
        }
        if !entry.path().is_dir() || !entry.path().join("SKILL.md").is_file() {
            return Err("Refusing to replace unmanaged agent Skill content".into());
        }
    }
    read_skill_manifest(skills)?;
    Ok(())
}

fn selection_entries(skills: &Path) -> Result<Vec<String>, String> {
    let mut entries = fs::read_dir(skills)
        .map_err(|e| e.to_string())?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    entries.sort();
    // Codex installs and updates its own bundled skills after our publication.
    entries.retain(|name| name != NATIVE_SYSTEM_SKILLS);
    Ok(entries)
}

fn reject_staged_system_skills(skills: &Path) -> Result<(), String> {
    let system = skills.join(NATIVE_SYSTEM_SKILLS);
    if system.exists() || system.is_symlink() {
        return Err("The .system Skills directory is reserved for the native engine".into());
    }
    Ok(())
}

fn preserve_system_skills(backup: &Path, target: &Path) -> Result<(), String> {
    let source = backup.join(NATIVE_SYSTEM_SKILLS);
    let destination = target.join(NATIVE_SYSTEM_SKILLS);
    match fs::symlink_metadata(&source) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if !metadata.is_dir() => {
            return Err("Native system Skills must be a real directory".into())
        }
        Ok(_) => {}
    }
    if destination.exists() || destination.is_symlink() {
        return Err("Native system Skills recovery destination is occupied".into());
    }
    // Move intact, including native metadata and any user changes; never delete
    // or copy this engine-owned tree into the shared package store.
    fs::rename(source, destination).map_err(|error| error.to_string())
}

fn recover(home: &Path) -> Result<(), String> {
    let pending_path = home.join("capabilities.pending.json");
    let bytes = match fs::read(&pending_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let pending: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let name = pending
        .get("stage")
        .and_then(Value::as_str)
        .ok_or("Invalid pending Skills publication")?;
    if pending["schema_version"] != 2
        || !name.starts_with(".skills-")
        || Path::new(name).components().count() != 1
        || !matches!(
            Path::new(name).components().next(),
            Some(Component::Normal(_))
        )
    {
        return Err("Invalid pending Skills staging path".into());
    }
    let staged = home.join(name);
    let backup = home.join(format!("{name}-previous"));
    let target = home.join("skills");
    if staged.exists() {
        reject_staged_system_skills(&staged)?;
        if staged.is_symlink() {
            return Err("Invalid Skills staging link".into());
        }
        validate_selection(&staged)?;
        if serde_json::to_value(read_skill_manifest(&staged)?).map_err(|e| e.to_string())?
            != pending["skills"]
            || json!(selection_entries(&staged)?) != pending["entries"]
        {
            return Err("Pending Skills records do not match staged selection".into());
        }
        if target.exists() || target.is_symlink() {
            if backup.exists() || backup.is_symlink() {
                return Err("Skills recovery destination is occupied".into());
            }
            check_managed_target(home, &target)?;
            fs::rename(&target, &backup).map_err(|error| error.to_string())?;
        } else if pending["had_target"] == true && !backup.exists() && !backup.is_symlink() {
            return Err("Previous Skills selection is missing".into());
        }
        fs::rename(&staged, &target).map_err(|error| error.to_string())?;
    }
    if target.is_symlink() {
        return Err("Published Skills directory must be direct".into());
    }
    preserve_system_skills(&backup, &target)?;
    if pending["had_system_skills"] == true && !target.join(NATIVE_SYSTEM_SKILLS).is_dir() {
        return Err("Native system Skills are missing during recovery".into());
    }
    validate_selection(&target)?;
    if serde_json::to_value(read_skill_manifest(&target)?).map_err(|e| e.to_string())?
        != pending["skills"]
        || json!(selection_entries(&target)?) != pending["entries"]
    {
        return Err("Pending Skills records do not match published selection".into());
    }
    write_json_file(
        &home.join("capabilities.json"),
        &json!({
            "schema_version": 2, "current": "skills", "skills": pending["skills"],
            "entries": pending["entries"],
        }),
    )?;
    if backup.is_symlink() {
        fs::remove_file(&backup).map_err(|error| error.to_string())?;
    } else if backup.exists() {
        validate_selection(&backup)?;
        fs::remove_dir_all(&backup).map_err(|error| error.to_string())?;
    }
    fs::remove_file(pending_path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::runtime_capabilities::{record_installed_skill, tests::skill_zip_entries};
    use crate::services::workbench::{link_package, publish_skill_archive};

    fn seed(home: &Path, workbench: &Path, version: &str, content: &str) -> HomeSkillsStage {
        let stage = HomeSkillsStage::prepare(home).unwrap();
        let archive = skill_zip_entries(&[("sample/SKILL.md", content)]);
        let package = publish_skill_archive(workbench, &archive, Some(version)).unwrap();
        link_package(&package.path, &stage.skills_dir().join("sample")).unwrap();
        record_installed_skill(
            &stage.skills_dir(),
            "sample",
            1,
            "default",
            Some(version.into()),
        )
        .unwrap();
        stage
    }

    #[test]
    fn direct_relative_links_survive_activation_and_version_switch() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("agents/person/default/Example");
        let first = format!("sha256:{}", "a".repeat(64));
        let second = format!("sha256:{}", "b".repeat(64));
        seed(&home, root.path(), &first, "v1").activate().unwrap();
        let link = home.join("skills/sample");
        assert!(!home.join("skills").is_symlink());
        assert!(fs::read_link(&link).unwrap().is_relative());
        assert_eq!(fs::read_to_string(link.join("SKILL.md")).unwrap(), "v1");
        let reused = HomeSkillsStage::prepare(&home).unwrap();
        reused.reuse(&["sample".into()]).unwrap();
        assert_eq!(
            read_skill_manifest(&reused.skills_dir()).unwrap()["sample"]
                .content_hash
                .as_deref(),
            Some(first.as_str())
        );
        reused.activate().unwrap();
        seed(&home, root.path(), &second, "v2").activate().unwrap();
        assert_eq!(fs::read_to_string(link.join("SKILL.md")).unwrap(), "v2");
        assert_eq!(
            fs::read_to_string(
                root.path()
                    .join("shared/skills")
                    .join(&first[7..])
                    .join("SKILL.md")
            )
            .unwrap(),
            "v1"
        );
        assert!(!home.join("capability-snapshots").exists());
        assert!(!home.join("capabilities.pending.json").exists());
    }

    #[test]
    fn incomplete_selection_and_unmanaged_content_preserve_current_files() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let version = format!("sha256:{}", "a".repeat(64));
        seed(&home, root.path(), &version, "v1").activate().unwrap();
        {
            let next = HomeSkillsStage::prepare(&home).unwrap();
            fs::write(next.skills_dir().join("unexpected"), "broken").unwrap();
            assert!(next.activate().is_err());
        }
        assert_eq!(
            fs::read_to_string(home.join("skills/sample/SKILL.md")).unwrap(),
            "v1"
        );
        fs::write(home.join("skills/personal.txt"), "user data").unwrap();
        assert!(HomeSkillsStage::prepare(&home).unwrap().activate().is_err());
        assert_eq!(
            fs::read_to_string(home.join("skills/personal.txt")).unwrap(),
            "user data"
        );
    }

    #[test]
    fn publication_recovers_at_each_rename_boundary_and_is_idempotent() {
        for phase in 0..4 {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("home");
            let first = format!("sha256:{}", "a".repeat(64));
            let second = format!("sha256:{}", "b".repeat(64));
            seed(&home, root.path(), &first, "v1").activate().unwrap();
            let system = home.join("skills/.system");
            fs::create_dir_all(system.join("skill-creator")).unwrap();
            fs::write(system.join("skill-creator/SKILL.md"), "native skill").unwrap();
            fs::write(system.join("native-marker"), "keep").unwrap();
            #[cfg(unix)]
            let system_inode = {
                use std::os::unix::fs::MetadataExt;
                fs::metadata(&system).unwrap().ino()
            };
            let next = seed(&home, root.path(), &second, "v2");
            let staged = next.staging.keep();
            let name = staged.file_name().unwrap().to_str().unwrap();
            write_json_file(&home.join("capabilities.pending.json"), &json!({
                "schema_version": 2, "stage": name, "had_target": true, "had_system_skills": true,
                "skills": read_skill_manifest(&staged).unwrap(), "entries": selection_entries(&staged).unwrap(),
            })).unwrap();
            if phase >= 1 {
                fs::rename(home.join("skills"), home.join(format!("{name}-previous"))).unwrap();
            }
            if phase >= 2 {
                fs::rename(&staged, home.join("skills")).unwrap();
            }
            if phase >= 3 {
                preserve_system_skills(
                    &home.join(format!("{name}-previous")),
                    &home.join("skills"),
                )
                .unwrap();
            }
            recover(&home).unwrap();
            let marker = fs::read(home.join("capabilities.json")).unwrap();
            recover(&home).unwrap();
            assert_eq!(fs::read(home.join("capabilities.json")).unwrap(), marker);
            assert_eq!(
                fs::read_to_string(home.join("skills/sample/SKILL.md")).unwrap(),
                "v2"
            );
            assert!(!home.join("capabilities.pending.json").exists());
            assert_eq!(
                fs::read_to_string(system.join("native-marker")).unwrap(),
                "keep"
            );
            assert_eq!(
                fs::read_to_string(system.join("skill-creator/SKILL.md")).unwrap(),
                "native skill"
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                assert_eq!(fs::metadata(system).unwrap().ino(), system_inode);
            }
        }
    }

    #[test]
    fn native_system_skills_survive_followup_and_empty_selection() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        seed(&home, root.path(), &"a".repeat(64), "v1")
            .activate()
            .unwrap();
        let system = home.join("skills/.system");
        fs::create_dir_all(system.join("native")).unwrap();
        fs::write(system.join("native/SKILL.md"), "native").unwrap();
        let next = HomeSkillsStage::prepare(&home).unwrap();
        next.reuse(&["sample".into()]).unwrap();
        next.activate().unwrap();
        assert_eq!(
            fs::read_to_string(system.join("native/SKILL.md")).unwrap(),
            "native"
        );
        HomeSkillsStage::prepare(&home).unwrap().activate().unwrap();
        assert!(!home.join("skills/sample").exists());
        assert_eq!(
            fs::read_to_string(system.join("native/SKILL.md")).unwrap(),
            "native"
        );
        let next = HomeSkillsStage::prepare(&home).unwrap();
        assert!(next.reuse(&[".system".into()]).is_err());
        fs::create_dir(next.skills_dir().join(".system")).unwrap();
        assert!(next.activate().is_err());
        assert_eq!(
            fs::read_to_string(system.join("native/SKILL.md")).unwrap(),
            "native"
        );
    }

    #[cfg(unix)]
    #[test]
    fn system_symlink_is_not_accepted_or_followed() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        seed(&home, root.path(), &"a".repeat(64), "v1")
            .activate()
            .unwrap();
        let external = root.path().join("personal");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("keep"), "user data").unwrap();
        std::os::unix::fs::symlink(&external, home.join("skills/.system")).unwrap();
        assert!(HomeSkillsStage::prepare(&home).unwrap().activate().is_err());
        assert_eq!(
            fs::read_to_string(external.join("keep")).unwrap(),
            "user data"
        );
    }
}
