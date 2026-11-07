//! Native Home skill selection, manifests, and lease-protected publication.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use wegent_filesystem::json_file::write_json_file;
mod home_skills;
pub use home_skills::HomeSkillsStage;
pub(crate) const SKILL_MANIFEST_FILE: &str = ".wegent-skills.json";

pub fn copy_skill_directory(source: &Path, target: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source)
        .map_err(|error| format!("failed to read Skill source {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("failed to read Skill entry: {error}"))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect Skill entry: {error}"))?;
        if file_type.is_dir() {
            fs::create_dir_all(&target_path)
                .map_err(|error| format!("failed to create Skill directory: {error}"))?;
            copy_skill_directory(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path)
                .map_err(|error| format!("failed to copy Skill file: {error}"))?;
        } else {
            return Err(format!(
                "unsupported Skill entry type: {}",
                source_path.display()
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledSkillRecord {
    pub skill_id: i64,
    pub namespace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

pub fn skill_manifest_path(skills_dir: &Path) -> PathBuf {
    skills_dir.join(SKILL_MANIFEST_FILE)
}

pub fn read_skill_manifest(
    skills_dir: &Path,
) -> Result<BTreeMap<String, InstalledSkillRecord>, String> {
    let path = skill_manifest_path(skills_dir);
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

pub fn write_skill_manifest(
    skills_dir: &Path,
    manifest: &BTreeMap<String, InstalledSkillRecord>,
) -> Result<(), String> {
    write_json_file(&skill_manifest_path(skills_dir), manifest)
}

pub fn record_installed_skill(
    skills_dir: &Path,
    skill_name: &str,
    skill_id: i64,
    namespace: &str,
    content_hash: Option<String>,
) -> Result<(), String> {
    let mut manifest = read_skill_manifest(skills_dir)?;
    manifest.insert(
        skill_name.to_owned(),
        InstalledSkillRecord {
            skill_id,
            namespace: namespace.to_owned(),
            content_hash,
        },
    );
    write_skill_manifest(skills_dir, &manifest)
}

/// Publish the agent's latest Skill selection for browsing.
/// Native configuration stays in the task's private execution snapshot.
/// The caller holds the Home preparation lease.
pub fn publish_agent_skills(home: &Path, snapshot: &Path) -> Result<(), String> {
    let names = read_skill_manifest(&snapshot.join("skills"))?
        .into_keys()
        .collect::<Vec<_>>();
    let stage = HomeSkillsStage::prepare(home)?;
    stage.reuse_from(snapshot, &names)?;
    stage.activate()
}
