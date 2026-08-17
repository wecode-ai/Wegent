// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
};

use serde_json::Value;

const PLUGIN_URI_PREFIX: &str = "plugin://";
const CODEX_PLUGIN_MANIFEST: &str = ".codex-plugin/plugin.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PluginEntrySkill {
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug, Default)]
pub(super) struct PluginSkillResolver {
    entries: HashMap<String, PluginEntrySkill>,
}

impl PluginSkillResolver {
    pub fn load(codex_home: &Path, capability_manifest_path: &Path) -> Self {
        let Ok(content) = fs::read_to_string(capability_manifest_path) else {
            return Self::default();
        };
        let Ok(manifest) = serde_json::from_str::<Value>(&content) else {
            return Self::default();
        };
        let Some(plugins) = manifest.get("plugins").and_then(Value::as_object) else {
            return Self::default();
        };

        let mut entries = HashMap::new();
        for (key, plugin) in plugins {
            if plugin.get("enabled").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let Some(name) = manifest_string(plugin, "name")
                .or_else(|| key.rsplit_once('@').map(|(name, _)| name.to_owned()))
            else {
                continue;
            };
            let Some(marketplace) = manifest_string(plugin, "marketplace").or_else(|| {
                key.rsplit_once('@')
                    .map(|(_, marketplace)| marketplace.to_owned())
            }) else {
                continue;
            };
            let Some(version) = manifest_string(plugin, "version") else {
                continue;
            };
            if !safe_relative_path(&name)
                || !safe_relative_path(&marketplace)
                || !safe_relative_path(&version)
            {
                continue;
            }

            let plugin_root = codex_home
                .join("plugins/cache")
                .join(&marketplace)
                .join(&name)
                .join(&version);
            let Some(skill) = discover_entry_skill(&plugin_root, &name) else {
                continue;
            };
            entries.insert(
                format!("{PLUGIN_URI_PREFIX}{name}@{marketplace}"),
                PluginEntrySkill {
                    name: format!("{name}:{}", skill.name),
                    path: skill.path,
                },
            );
        }
        Self { entries }
    }

    pub fn resolve(&self, uri: &str) -> Option<&PluginEntrySkill> {
        self.entries.get(uri)
    }
}

fn manifest_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn safe_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn discover_entry_skill(plugin_root: &Path, plugin_name: &str) -> Option<PluginEntrySkill> {
    let manifest_path = plugin_root.join(CODEX_PLUGIN_MANIFEST);
    let manifest = serde_json::from_str::<Value>(&fs::read_to_string(manifest_path).ok()?).ok()?;
    let skills_path = manifest
        .get("skills")?
        .as_str()?
        .trim()
        .trim_start_matches("./");
    if skills_path.is_empty() || !safe_relative_path(skills_path) {
        return None;
    }

    let skills_root = plugin_root.join(skills_path);
    let mut skills = Vec::new();
    collect_skills(&skills_root, &mut skills, 0);
    select_entry_skill(skills, plugin_name)
}

fn collect_skills(root: &Path, skills: &mut Vec<PluginEntrySkill>, depth: usize) {
    if depth > 4 || skills.len() >= 256 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_skills(&path, skills, depth + 1);
            continue;
        }
        if file_type.is_file() && entry.file_name() == "SKILL.md" {
            let Some(name) = skill_name(&path) else {
                continue;
            };
            skills.push(PluginEntrySkill { name, path });
        }
    }
}

fn skill_name(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        let Some(value) = line.strip_prefix("name:") else {
            continue;
        };
        let name = value
            .trim()
            .trim_matches(|character| character == '\'' || character == '"');
        if !name.is_empty() {
            return Some(name.to_owned());
        }
    }
    None
}

fn select_entry_skill(
    mut skills: Vec<PluginEntrySkill>,
    plugin_name: &str,
) -> Option<PluginEntrySkill> {
    if skills.len() == 1 {
        return skills.pop();
    }
    if let Some(index) = skills.iter().position(|skill| skill.name == plugin_name) {
        return Some(skills.swap_remove(index));
    }

    let mut candidates = skills
        .iter()
        .filter(|candidate| {
            let prefix = format!("{}-", candidate.name);
            skills
                .iter()
                .all(|skill| skill.name == candidate.name || skill.name.starts_with(&prefix))
        })
        .cloned()
        .collect::<Vec<_>>();
    (candidates.len() == 1).then(|| candidates.swap_remove(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(name: &str) -> PluginEntrySkill {
        PluginEntrySkill {
            name: name.to_owned(),
            path: PathBuf::from(format!("/plugins/sample/skills/{name}/SKILL.md")),
        }
    }

    #[test]
    fn selects_the_plugin_named_skill_as_the_entry_point() {
        let selected = select_entry_skill(
            vec![skill("gitlab-intra-fix-ci"), skill("gitlab-intra")],
            "gitlab-intra",
        )
        .expect("plugin-named skill should be selected");

        assert_eq!(selected.name, "gitlab-intra");
    }

    #[test]
    fn selects_a_shared_prefix_skill_as_the_entry_point() {
        let selected = select_entry_skill(
            vec![skill("gitlab-cn-publish"), skill("gitlab-cn")],
            "gitlab-weibo",
        )
        .expect("shared prefix skill should be selected");

        assert_eq!(selected.name, "gitlab-cn");
    }

    #[test]
    fn leaves_ambiguous_multi_skill_plugins_unbound() {
        assert_eq!(
            select_entry_skill(vec![skill("calendar"), skill("documents")], "workplace"),
            None
        );
    }
}
