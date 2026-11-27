// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{BTreeSet, HashSet},
    fs,
    path::{Component, Path, PathBuf},
};

use serde_json::{json, Value};

use crate::local::local_skills::{parse_frontmatter, parse_frontmatter_content};

use super::{
    runtime_recovery::safe_managed_path,
    support::{read_plugin_manifest, sorted_dir_entries, PLUGIN_MANIFEST_PATHS},
    CapabilitySyncError,
};

/// Keep the recursive default scan additive to the effective manifest's selections.
pub(crate) fn scan_plugin_skills(plugin_path: &Path) -> Result<Vec<Value>, CapabilitySyncError> {
    scan_plugin_skills_with_inventory(plugin_path, None)
}

/// Local inventory owns only its nearest manifest root and preserves lossy metadata reads.
pub(crate) fn scan_local_plugin_skills(
    plugin_path: &Path,
    manifest_roots: &HashSet<PathBuf>,
) -> Result<Vec<Value>, CapabilitySyncError> {
    scan_plugin_skills_with_inventory(plugin_path, Some(manifest_roots))
}

fn scan_plugin_skills_with_inventory(
    plugin_path: &Path,
    inventory: Option<&HashSet<PathBuf>>,
) -> Result<Vec<Value>, CapabilitySyncError> {
    let manifest = skill_manifest(plugin_path)?;
    let declarations = manifest
        .as_ref()
        .and_then(|manifest| manifest.get("skills"));
    let default = plugin_path.join("skills");
    safe_managed_path(plugin_path, &default, false)?;
    let mut pending = vec![default.clone()];
    let mut files = BTreeSet::new();
    for directory in declared_skill_directories(plugin_path, declarations, inventory)? {
        let skill = directory.join("SKILL.md");
        safe_managed_path(plugin_path, &skill, false)?;
        if skill.is_file() {
            files.insert(skill);
        } else {
            pending.push(directory);
        }
    }
    if !default.is_dir() && declarations.is_none() {
        let skill = plugin_path.join("SKILL.md");
        safe_managed_path(plugin_path, &skill, false)?;
        if skill.is_file() {
            files.insert(skill);
        }
    }
    collect_skill_files(plugin_path, pending, &mut files, inventory)?;
    let root_name = manifest
        .as_ref()
        .and_then(|manifest| manifest["name"].as_str());
    let mut files: Vec<_> = files.into_iter().collect();
    files.sort_by_cached_key(|path| path.to_string_lossy().replace('\\', "/"));
    files
        .iter()
        .map(|path| read_plugin_skill(plugin_path, path, root_name, inventory.is_some()))
        .collect()
}

fn owned_by_child_plugin(
    plugin_path: &Path,
    path: &Path,
    inventory: Option<&HashSet<PathBuf>>,
) -> bool {
    inventory.is_some_and(|roots| {
        path.ancestors()
            .take_while(|ancestor| *ancestor != plugin_path)
            .any(|ancestor| roots.contains(ancestor))
    })
}

fn skill_manifest(plugin_path: &Path) -> Result<Option<Value>, CapabilitySyncError> {
    let paths = PLUGIN_MANIFEST_PATHS.map(|relative| plugin_path.join(relative));
    for path in &paths {
        safe_managed_path(plugin_path, path, false)?;
    }
    for path in paths {
        if let Some(manifest) = read_plugin_manifest(&path)? {
            return Ok(Some(manifest));
        }
    }
    Ok(None)
}

fn declared_skill_directories(
    plugin_path: &Path,
    declarations: Option<&Value>,
    inventory: Option<&HashSet<PathBuf>>,
) -> Result<BTreeSet<PathBuf>, CapabilitySyncError> {
    let Some(declarations) = declarations else {
        return Ok(BTreeSet::new());
    };
    let paths = match declarations {
        Value::String(_) => std::slice::from_ref(declarations),
        Value::Array(paths) => paths.as_slice(),
        _ => {
            return Err(CapabilitySyncError::invalid_payload(
                "Plugin skills must be a directory path or array of directory paths",
            ));
        }
    };
    let mut directories = BTreeSet::new();
    for value in paths {
        let directory = plugin_path.join(skill_directory_path(value)?);
        if owned_by_child_plugin(plugin_path, &directory, inventory) {
            continue;
        }
        safe_managed_path(plugin_path, &directory, false)?;
        if directory.exists() && !directory.is_dir() {
            return Err(CapabilitySyncError::invalid_payload(
                "Declared plugin skill path is not a directory",
            ));
        }
        directories.insert(directory);
    }
    Ok(directories)
}

fn skill_directory_path(value: &Value) -> Result<PathBuf, CapabilitySyncError> {
    let path = value
        .as_str()
        .ok_or_else(|| {
            CapabilitySyncError::invalid_payload("Plugin skill directory paths must be strings")
        })?
        .trim();
    let relative = Path::new(path);
    let directory: PathBuf = relative
        .components()
        .filter(|component| !matches!(component, Component::CurDir))
        .collect();
    let normalized = directory.to_string_lossy();
    let has_drive = normalized
        .as_bytes()
        .get(..2)
        .is_some_and(|prefix| prefix[0].is_ascii_alphabetic() && prefix[1] == b':');
    if path.is_empty()
        || path.contains(['\\', '\0'])
        || has_drive
        || relative.components().any(|component| {
            matches!(
                component,
                Component::Prefix(_) | Component::RootDir | Component::ParentDir
            )
        })
    {
        return Err(CapabilitySyncError::invalid_payload(
            "Plugin skill paths must be non-empty plugin-relative directories without parent traversal",
        ));
    }
    Ok(directory)
}

fn collect_skill_files(
    plugin_path: &Path,
    mut pending: Vec<PathBuf>,
    files: &mut BTreeSet<PathBuf>,
    inventory: Option<&HashSet<PathBuf>>,
) -> Result<(), CapabilitySyncError> {
    let mut visited = BTreeSet::new();
    while let Some(directory) = pending.pop() {
        if owned_by_child_plugin(plugin_path, &directory, inventory) {
            continue;
        }
        safe_managed_path(plugin_path, &directory, false)?;
        if !visited.insert(directory.clone()) {
            continue;
        }
        let scan_directory = if directory == plugin_path && directory.is_symlink() {
            fs::canonicalize(&directory)?
        } else {
            directory.clone()
        };
        for entry in sorted_dir_entries(&scan_directory)? {
            let path = directory.join(entry.file_name());
            if owned_by_child_plugin(plugin_path, &path, inventory) {
                continue;
            }
            safe_managed_path(plugin_path, &path, false)?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file() && entry.file_name() == "SKILL.md" {
                files.insert(path);
            }
        }
    }
    Ok(())
}

fn read_plugin_skill(
    plugin_path: &Path,
    path: &Path,
    root_name: Option<&str>,
    local_inventory: bool,
) -> Result<Value, CapabilitySyncError> {
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
    let metadata = if local_inventory {
        parse_frontmatter(path)
    } else {
        parse_frontmatter_content(&fs::read_to_string(path)?)
    };
    let name = metadata
        .get("name")
        .filter(|name| !name.is_empty())
        .cloned()
        .or_else(|| {
            if relative.is_empty() {
                root_name.filter(|name| !name.is_empty()).map(str::to_owned)
            } else {
                None
            }
        })
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
        "path": if relative.is_empty() { "." } else { &relative },
    }))
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use super::super::support::extract_plugin_zip;
    use super::*;

    #[test]
    fn root_skill_with_empty_frontmatter_name_uses_manifest_name() {
        let temporary = tempfile::tempdir().unwrap();
        write_manifest(
            temporary.path(),
            PLUGIN_MANIFEST_PATHS[0],
            &json!({"name": "example"}),
        );
        for value in ["", "''", "\"\""] {
            fs::write(
                temporary.path().join("SKILL.md"),
                format!("---\nname: {value}\n---\n"),
            )
            .unwrap();

            let skills = scan_plugin_skills(temporary.path()).unwrap();

            assert_eq!(skills[0]["name"], "example");
        }
    }

    #[test]
    fn managed_skill_metadata_uses_top_level_keys_and_normalizes_line_endings() {
        let temporary = tempfile::tempdir().unwrap();
        write_manifest(
            temporary.path(),
            PLUGIN_MANIFEST_PATHS[0],
            &json!({"name": "example"}),
        );
        for newline in ["\n", "\r\n"] {
            let content = "---\nname: actual-name\ndescription: |\n  First line\n  second line\nmetadata:\n  name: internal-id\n  description: Internal description\n---\n".replace('\n', newline);
            fs::write(temporary.path().join("SKILL.md"), content).unwrap();

            let skills = scan_plugin_skills(temporary.path()).unwrap();

            assert_eq!(skills[0]["name"], "actual-name");
            assert_eq!(skills[0]["description"], "First line\nsecond line");
        }
    }

    fn write_manifest(root: &Path, relative: &str, manifest: &Value) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, manifest.to_string()).unwrap();
    }

    fn write_skills(root: &Path, paths: &[&str]) {
        for relative in paths {
            let path = root.join(relative).join("SKILL.md");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "# Skill").unwrap();
        }
    }

    fn scanned_paths(root: &Path) -> Vec<String> {
        scan_plugin_skills(root)
            .unwrap()
            .iter()
            .map(|skill| skill["path"].as_str().unwrap().to_owned())
            .collect()
    }

    fn discovery_case_zip(case: &Value, prefix: &str) -> Vec<u8> {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::FileOptions::default();
        archive
            .start_file(format!("{prefix}{}", PLUGIN_MANIFEST_PATHS[0]), options)
            .unwrap();
        archive
            .write_all(case["manifest"].to_string().as_bytes())
            .unwrap();
        for directory in case["directories"].as_array().unwrap() {
            archive
                .add_directory(format!("{prefix}{}", directory.as_str().unwrap()), options)
                .unwrap();
        }
        for file in case["files"].as_array().unwrap() {
            archive
                .start_file(format!("{prefix}{}", file.as_str().unwrap()), options)
                .unwrap();
            archive.write_all(b"# Skill").unwrap();
        }
        archive.finish().unwrap().into_inner()
    }

    #[test]
    fn extracted_packages_match_shared_discovery_cases() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../shared/protocol/plugin_skill_discovery_cases.json"
        )))
        .unwrap();
        for case in cases {
            for prefix in ["", "package/"] {
                let temp = tempfile::tempdir().unwrap();
                let root = temp.path().join("plugin");
                let bytes = discovery_case_zip(&case, prefix);
                extract_plugin_zip(&bytes, &root).unwrap();
                assert_eq!(
                    json!(scanned_paths(&root)),
                    case["paths"],
                    "case={} prefix={prefix:?}",
                    case["name"]
                );
            }
        }
    }

    #[test]
    fn root_fallback_is_single_and_uses_manifest_name_after_frontmatter() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugin-folder");
        write_skills(&root, &[".", "unselected/child"]);
        assert_eq!(
            scan_plugin_skills(&root).unwrap(),
            vec![json!({"name":"plugin-folder","description":"","path":"."})]
        );
        write_manifest(
            &root,
            PLUGIN_MANIFEST_PATHS[1],
            &json!({"name":"manifest-name"}),
        );
        assert_eq!(
            scan_plugin_skills(&root).unwrap()[0]["name"],
            "manifest-name"
        );
        fs::write(root.join("SKILL.md"), "---\nname: frontmatter-name\n---\n").unwrap();
        assert_eq!(
            scan_plugin_skills(&root).unwrap()[0]["name"],
            "frontmatter-name"
        );
        fs::create_dir(root.join("skills")).unwrap();
        assert!(scan_plugin_skills(&root).unwrap().is_empty());
    }

    #[test]
    fn overlapping_custom_roots_keep_folder_names_and_downstream_duplicate_rejection() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugin");
        write_skills(&root, &["skills/child", "custom/child"]);
        write_manifest(
            &root,
            PLUGIN_MANIFEST_PATHS[0],
            &json!({
                "name":"manifest-name",
                "skills":["custom", " ./custom/ ", "custom/child"],
            }),
        );
        assert_eq!(
            scan_plugin_skills(&root).unwrap(),
            vec![
                json!({"name":"child","description":"","path":"custom/child"}),
                json!({"name":"child","description":"","path":"skills/child"}),
            ]
        );
        assert!(
            super::super::runtime_skill_config::plugin_skill_paths(&root)
                .unwrap_err()
                .to_string()
                .contains("duplicate skill names")
        );
    }

    #[test]
    fn explicit_root_without_a_root_skill_recurses_and_declarations_disable_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugin");
        write_skills(&root, &["custom/group", "custom/group/child"]);
        write_manifest(&root, PLUGIN_MANIFEST_PATHS[1], &json!({"skills":"."}));
        assert_eq!(
            scanned_paths(&root),
            vec!["custom/group", "custom/group/child"]
        );
        write_skills(&root, &["."]);
        write_manifest(
            &root,
            PLUGIN_MANIFEST_PATHS[1],
            &json!({"skills":"custom/group"}),
        );
        assert_eq!(scanned_paths(&root), vec!["custom/group"]);
    }

    #[test]
    fn effective_manifest_priority_does_not_merge_skills_declarations() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugin");
        write_skills(&root, &["codex", "claude"]);
        write_manifest(&root, PLUGIN_MANIFEST_PATHS[1], &json!({"skills":"claude"}));
        assert_eq!(scanned_paths(&root), vec!["claude"]);
        write_manifest(&root, PLUGIN_MANIFEST_PATHS[0], &json!({"skills":"codex"}));
        assert_eq!(scanned_paths(&root), vec!["codex"]);
        write_manifest(&root, PLUGIN_MANIFEST_PATHS[0], &json!({"name":"codex"}));
        assert!(scan_plugin_skills(&root).unwrap().is_empty());
    }

    #[test]
    fn malformed_declarations_and_non_directory_paths_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugin");
        write_skills(&root, &["skills/default", "custom"]);
        for skills in [
            json!(null),
            json!(false),
            json!(1),
            json!({"path":"custom"}),
            json!(""),
            json!(" \t"),
            json!(["custom", ""]),
            json!(["custom", null]),
            json!(["custom", ["custom"]]),
            json!("/outside"),
            json!("//server/share"),
            json!("C:/outside"),
            json!("C:outside"),
            json!("./C:/outside"),
            json!("./C:outside"),
            json!(".//C:/outside"),
            json!("././C:outside"),
            json!("custom\\child"),
            json!("../outside"),
            json!("custom/../custom"),
            json!("custom/../../outside"),
            json!("custom\0child"),
            json!("custom/SKILL.md"),
        ] {
            write_manifest(&root, PLUGIN_MANIFEST_PATHS[0], &json!({"skills":skills}));
            assert!(scan_plugin_skills(&root).is_err(), "skills={skills}");
        }
        for manifest in ["null", "[]", "\"custom\"", "{"] {
            fs::write(root.join(PLUGIN_MANIFEST_PATHS[0]), manifest).unwrap();
            assert!(scan_plugin_skills(&root).is_err(), "manifest={manifest}");
        }
        write_manifest(&root, PLUGIN_MANIFEST_PATHS[0], &json!({"skills":[]}));
        assert_eq!(scanned_paths(&root), vec!["skills/default"]);
    }

    #[test]
    fn declared_skill_directory_below_a_file_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugin");
        write_manifest(
            &root,
            PLUGIN_MANIFEST_PATHS[0],
            &json!({"name":"example", "skills":"readme/child"}),
        );
        fs::write(root.join("readme"), "Not a directory").unwrap();

        let error = scan_plugin_skills(&root).unwrap_err();

        assert!(error.to_string().contains("parent is not a directory"));
    }

    #[test]
    fn scan_parses_multiline_descriptions_with_local_frontmatter_rules() {
        for (description, expected) in [
            ("|\n  line one\n  line two", "line one\nline two"),
            (
                ">\n  first paragraph\n  still first\n\n  second paragraph",
                "first paragraph still first\nsecond paragraph",
            ),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("plugin");
            write_manifest(
                &root,
                PLUGIN_MANIFEST_PATHS[0],
                &json!({"name":"example", "skills":"review"}),
            );
            write_skills(&root, &["review"]);
            fs::write(
                root.join("review/SKILL.md"),
                format!("---\ndescription: {description}\nname: multiline\n---\nname: body-name\n"),
            )
            .unwrap();

            assert_eq!(
                scan_plugin_skills(&root).unwrap(),
                vec![json!({"name":"multiline", "description":expected, "path":"review"})],
            );
        }
    }

    #[test]
    fn scan_rejects_non_utf8_skill_content() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugin");
        write_skills(&root, &["skills/review"]);
        fs::write(root.join("skills/review/SKILL.md"), b"\xff").unwrap();

        let error = scan_plugin_skills(&root).unwrap_err();

        assert!(matches!(
            error,
            CapabilitySyncError::Io(error) if error.kind() == std::io::ErrorKind::InvalidData
        ));
    }

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
        write_manifest(
            &root,
            PLUGIN_MANIFEST_PATHS[0],
            &json!({"skills":"./skills"}),
        );
        assert_eq!(scan_plugin_skills(&root).unwrap(), scanned);
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
        write_skills(&root, &[".", "custom/group"]);
        write_manifest(
            &root,
            PLUGIN_MANIFEST_PATHS[0],
            &json!({
                "name":"manifest-name", "skills":[".", "custom"],
            }),
        );
        assert_eq!(
            scan_plugin_skills(&alias).unwrap(),
            scan_plugin_skills(&root).unwrap()
        );
        fs::remove_file(root.join("SKILL.md")).unwrap();
        assert_eq!(
            scan_plugin_skills(&alias).unwrap(),
            scan_plugin_skills(&root).unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn scan_rejects_custom_root_skill_and_manifest_symlinks() {
        for (relative, selection) in [
            ("custom", Some("custom")),
            ("custom/group", Some("custom")),
            ("custom/group/feature", Some("custom/group/feature")),
            (
                "custom/group/feature/SKILL.md",
                Some("custom/group/feature"),
            ),
            ("custom/group/feature/loop", Some("custom")),
            ("SKILL.md", Some(".")),
            ("SKILL.md", None),
            (".codex-plugin", Some("custom")),
            (".codex-plugin/plugin.json", Some("custom")),
            (".claude-plugin", Some("custom")),
            (".claude-plugin/plugin.json", Some("custom")),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("plugin");
            write_skills(&root, &[".", "custom/group/feature"]);
            let mut manifest = json!({"name":"manifest-name"});
            if let Some(selection) = selection {
                manifest["skills"] = json!(selection);
            }
            for relative in PLUGIN_MANIFEST_PATHS {
                write_manifest(&root, relative, &manifest);
            }
            let path = root.join(relative);
            let external = temp.path().join("outside");
            let destination = if relative.ends_with("/loop") {
                root.join("custom")
            } else {
                fs::rename(&path, &external).unwrap();
                external
            };
            std::os::unix::fs::symlink(destination, path).unwrap();

            let error = scan_plugin_skills(&root).unwrap_err();
            assert!(error.to_string().contains("symlink"), "{relative}: {error}");
        }
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
