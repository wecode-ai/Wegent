// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use crate::protocol::ExecutionRequest;

use super::{deploy_request_skills, has_task_skill_names, primary_bot, project_workspace_path};

pub async fn prepare_codex_runtime(request: &ExecutionRequest) -> Result<(), String> {
    let _capability_lease = crate::services::capability_activation::begin_execution().await;
    let _home_lease = crate::agents::instance_home::acquire(request)?;
    prepare_codex_runtime_locked(request).await
}

pub(crate) async fn prepare_codex_runtime_locked(request: &ExecutionRequest) -> Result<(), String> {
    super::validate_coordinate_grant_source(request)?;
    // Native plugin Skills stay under Codex ownership. Selected backend Skills
    // still need deployment when a Wework profile has no named Agent Home.
    if primary_bot(request).is_none() {
        return Ok(());
    }
    if let Some(home) = crate::agents::instance_home::request_home(request) {
        if crate::agents::instance_home::personal_team(request) {
            if let Some(workspace) = project_workspace_path(request) {
                retire_workspace_skills(&workspace, &home)?;
            }
        }
        return deploy_request_skills(request, &home.join("skills")).await;
    }
    if has_task_skill_names(request) {
        let workspace = project_workspace_path(request)
            .ok_or_else(|| "selected Skills require a task workspace".to_owned())?;
        return deploy_request_skills(request, &workspace.join(".codex/skills")).await;
    }
    Ok(())
}

/// Older local Teams installed downloaded Skills alongside user-authored project
/// Skills. Retain their contents outside the native discovery directory.
fn retire_workspace_skills(
    workspace: &std::path::Path,
    home: &std::path::Path,
) -> Result<(), String> {
    use std::fs;
    use wegent_plugin_packages::skill_selection::{read_skill_manifest, skill_manifest_path};
    let config = workspace.join(".codex");
    let skills = config.join("skills");
    let manifest = skill_manifest_path(&skills);
    if !manifest.exists() {
        return Ok(());
    }
    if config.is_symlink() || skills.is_symlink() || manifest.is_symlink() {
        return Err("Cannot migrate linked workspace Skill metadata".into());
    }
    let lock = match fs::File::open(&manifest) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    fs2::FileExt::lock_exclusive(&lock).map_err(|error| error.to_string())?;
    if !manifest.exists() {
        return Ok(());
    }
    if home
        .canonicalize()
        .map_err(|error| error.to_string())?
        .starts_with(
            workspace
                .canonicalize()
                .map_err(|error| error.to_string())?,
        )
    {
        return Err("Cannot archive downloaded Skills inside their project".into());
    }
    let records = read_skill_manifest(&skills)?;
    for name in records.keys() {
        crate::services::skill_deployer::validate_skill_name(name)?;
        if name.starts_with('.') {
            return Err("Cannot migrate reserved workspace Skill name".into());
        }
    }
    let archive = tempfile::Builder::new()
        .prefix(".retired-skills-")
        .tempdir_in(home)
        .map_err(|error| error.to_string())?
        .keep();
    for name in records.keys() {
        match fs::rename(skills.join(name), archive.join(name)) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.to_string()),
        }
    }
    fs::rename(&manifest, skill_manifest_path(&archive)).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::retire_workspace_skills;
    use std::fs;
    use wegent_plugin_packages::skill_selection::record_installed_skill;

    #[test]
    fn migrate_downloaded_skills_without_modifying_project_skills() {
        let project = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let skills = project.path().join(".codex/skills");
        for name in ["downloaded", "user-authored"] {
            fs::create_dir_all(skills.join(name)).unwrap();
            fs::write(skills.join(name).join("SKILL.md"), name).unwrap();
        }
        record_installed_skill(&skills, "downloaded", 42, "default", None).unwrap();
        for _ in 0..2 {
            retire_workspace_skills(project.path(), home.path()).unwrap();
        }
        assert!(!skills.join("downloaded").exists());
        assert_eq!(
            fs::read_to_string(skills.join("user-authored/SKILL.md")).unwrap(),
            "user-authored"
        );
        let archive = fs::read_dir(home.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            fs::read_to_string(archive.join("downloaded/SKILL.md")).unwrap(),
            "downloaded"
        );
    }
}
