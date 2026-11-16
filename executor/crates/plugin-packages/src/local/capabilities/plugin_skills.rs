// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, fs, path::Path};

use serde_json::{json, Value};

use super::{
    runtime_recovery::safe_managed_path, support::sorted_dir_entries, CapabilitySyncError,
};

/// Match the cloud package scan, including skills at the root and below other skills.
pub(super) fn scan_plugin_skills(plugin_path: &Path) -> Result<Vec<Value>, CapabilitySyncError> {
    let mut pending = vec![plugin_path.join("skills")];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        safe_managed_path(plugin_path, &directory, false)?;
        for entry in sorted_dir_entries(&directory)? {
            let path = entry.path();
            safe_managed_path(plugin_path, &path, false)?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file() && entry.file_name() == "SKILL.md" {
                files.push(path);
            }
        }
    }
    files.sort();
    files
        .iter()
        .map(|path| read_plugin_skill(plugin_path, path))
        .collect()
}

fn read_plugin_skill(plugin_path: &Path, path: &Path) -> Result<Value, CapabilitySyncError> {
    safe_managed_path(plugin_path, path, false)?;
    let directory = path.parent().ok_or_else(|| {
        CapabilitySyncError::invalid_payload("Plugin skill has no parent directory")
    })?;
    let relative = directory
        .strip_prefix(plugin_path)
        .map_err(|_| {
            CapabilitySyncError::invalid_payload("Plugin skill is outside its current root")
        })?
        .to_string_lossy()
        .replace('\\', "/");
    let metadata = parse_skill_frontmatter(&fs::read_to_string(path)?);
    let name = metadata
        .get("name")
        .cloned()
        .or_else(|| {
            directory
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_owned)
        })
        .unwrap_or_default();
    Ok(json!({
        "name": name,
        "description": metadata.get("description").cloned().unwrap_or_default(),
        "path": relative,
    }))
}

fn parse_skill_frontmatter(content: &str) -> BTreeMap<String, String> {
    let mut metadata = BTreeMap::new();
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return metadata;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        metadata.insert(
            key.trim().to_owned(),
            value.trim().trim_matches(['"', '\'']).to_owned(),
        );
    }
    metadata
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_trims_both_frontmatter_delimiters_and_ignores_body_metadata() {
        for (opening, closing) in [("--- ", "---"), ("---", "--- \t"), ("\t --- ", " \t---\t")] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("plugin");
            let path = root.join("skills/package-folder/SKILL.md");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(
                path,
                format!(
                    "{opening}\nname: 'feature'\ndescription: Feature\n{closing}\nname: body-name\ndescription: Body\n"
                ),
            )
            .unwrap();

            assert_eq!(
                scan_plugin_skills(&root).unwrap(),
                vec![json!({
                    "name":"feature",
                    "description":"Feature",
                    "path":"skills/package-folder",
                })],
                "opening={opening:?} closing={closing:?}"
            );
        }
    }

    #[test]
    fn scan_includes_nested_skills_and_skill_roots_in_cloud_order() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugin");
        assert!(scan_plugin_skills(&root).unwrap().is_empty());
        for (path, name) in [
            ("SKILL.md", "excluded"),
            ("skills/zeta/SKILL.md", "zeta"),
            ("skills/group/feature/child/SKILL.md", "child"),
            ("skills/group/feature/SKILL.md", "'feature'"),
            ("skills/group/SKILL.md", "group"),
            ("skills/SKILL.md", "root-skill"),
        ] {
            let path = root.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, format!("---\nname: {name}\n---\n")).unwrap();
        }
        fs::create_dir_all(root.join("skills/empty")).unwrap();
        fs::write(root.join("skills/empty/README.md"), "No skill").unwrap();

        let scanned = scan_plugin_skills(&root).unwrap();

        assert_eq!(
            json!(scanned),
            json!([
                {"name":"root-skill","description":"","path":"skills"},
                {"name":"group","description":"","path":"skills/group"},
                {"name":"feature","description":"","path":"skills/group/feature"},
                {"name":"child","description":"","path":"skills/group/feature/child"},
                {"name":"zeta","description":"","path":"skills/zeta"},
            ])
        );
    }

    #[cfg(unix)]
    #[test]
    fn scan_allows_a_configured_root_alias() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugin");
        fs::create_dir_all(root.join("skills/group/feature")).unwrap();
        fs::write(root.join("skills/group/feature/SKILL.md"), "# Feature").unwrap();
        let alias = temp.path().join("configured-plugin");
        std::os::unix::fs::symlink(&root, &alias).unwrap();

        assert_eq!(
            scan_plugin_skills(&alias).unwrap(),
            scan_plugin_skills(&root).unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn scan_rejects_nested_symlinks_and_cycles() {
        for target in ["skills", "group", "directory", "file", "cycle"] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("plugin");
            let skill = root.join("skills/group/feature/SKILL.md");
            fs::create_dir_all(skill.parent().unwrap()).unwrap();
            fs::write(&skill, "# Feature").unwrap();
            let path = match target {
                "skills" => root.join("skills"),
                "group" => root.join("skills/group"),
                "directory" => root.join("skills/group/feature"),
                "file" => skill,
                "cycle" => root.join("skills/group/feature/loop"),
                _ => unreachable!(),
            };
            let external = temp.path().join("outside");
            let destination = if target == "cycle" {
                root.join("skills")
            } else {
                fs::rename(&path, &external).unwrap();
                external
            };
            std::os::unix::fs::symlink(destination, path).unwrap();

            let error = scan_plugin_skills(&root).unwrap_err();

            assert!(error.to_string().contains("symlink"), "{target}: {error}");
        }
    }
}
