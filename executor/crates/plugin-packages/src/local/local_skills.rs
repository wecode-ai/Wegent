// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Native implementation of the `ls_skills` device command. Scans the local
//! Codex skill directories, parses each `SKILL.md` frontmatter, deduplicates by
//! name and returns the same JSON array shape the previous embedded Python
//! script produced.

use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    time::{Instant, UNIX_EPOCH},
};

use serde_json::{json, Value};

use wegent_execution_contracts::command::CommandResult;

use super::capabilities::{scan_plugin_skills, PLUGIN_MANIFEST_PATHS};

const CODEX_USER_PRIORITY: i64 = 0;
const CODEX_SYSTEM_PRIORITY: i64 = 10;

/// A single discovered skill, mirroring the Python entry dict.
#[derive(Debug, Clone)]
struct SkillEntry {
    name: String,
    description: String,
    path: String,
    source: &'static str,
    scope: &'static str,
    source_priority: i64,
    plugin_name: Option<String>,
    plugin_provider: Option<String>,
    plugin_version: Option<String>,
    mtime: Option<f64>,
}

impl SkillEntry {
    fn to_json(&self) -> Value {
        let mut object = serde_json::Map::new();
        object.insert("name".to_owned(), json!(self.name));
        object.insert("description".to_owned(), json!(self.description));
        object.insert("path".to_owned(), json!(self.path));
        object.insert("source".to_owned(), json!(self.source));
        object.insert("scope".to_owned(), json!(self.scope));
        object.insert("origin".to_owned(), json!("local"));
        object.insert("source_priority".to_owned(), json!(self.source_priority));
        if !self.description.is_empty() {
            object.insert("short_description".to_owned(), json!(self.description));
        }
        if let Some(plugin_name) = &self.plugin_name {
            object.insert("plugin_name".to_owned(), json!(plugin_name));
        }
        if let Some(provider) = &self.plugin_provider {
            object.insert("plugin_provider".to_owned(), json!(provider));
        }
        if let Some(version) = &self.plugin_version {
            object.insert("plugin_version".to_owned(), json!(version));
        }
        if let Some(mtime) = self.mtime {
            object.insert("mtime".to_owned(), json!(mtime));
        }
        Value::Object(object)
    }

    fn identity(&self) -> String {
        let name = self.name.trim().to_lowercase();
        if name.is_empty() {
            self.path.clone()
        } else {
            name
        }
    }
}

/// List local Codex skills, returning a `CommandResult` whose `stdout` is the
/// deduplicated, sorted JSON array of skills.
pub async fn list_local_skills() -> CommandResult {
    let started_at = Instant::now();
    let result = tokio::task::spawn_blocking(|| {
        super::plugin_creator::install(&codex_home_dir())?;
        Ok::<_, String>(collect_skills())
    })
    .await;
    let (skills, error) = match result {
        Ok(Ok(skills)) => (skills, None),
        Ok(Err(error)) => (Vec::new(), Some(error)),
        Err(error) => (Vec::new(), Some(format!("Skill discovery failed: {error}"))),
    };
    let stdout = Value::Array(skills.iter().map(SkillEntry::to_json).collect());
    CommandResult {
        success: error.is_none(),
        exit_code: Some(if error.is_none() { 0 } else { 1 }),
        stdout,
        stderr: error.clone().unwrap_or_default(),
        duration: elapsed_seconds(started_at),
        timed_out: false,
        stdout_truncated: false,
        stderr_truncated: false,
        error,
    }
}

fn collect_skills() -> Vec<SkillEntry> {
    let codex_home = codex_home_dir();
    let codex_skills_root = codex_home.join("skills");

    let mut skills = Vec::new();
    skills.extend(scan_skill_dir(
        &codex_skills_root,
        "codex",
        "user",
        CODEX_USER_PRIORITY,
    ));
    skills.extend(scan_skill_dir(
        &codex_skills_root.join(".system"),
        "codex",
        "system",
        CODEX_SYSTEM_PRIORITY,
    ));
    skills.extend(scan_plugin_dir(&codex_home.join("plugins"), "codex-plugin"));

    deduplicate_and_sort(skills)
}

fn deduplicate_and_sort(skills: Vec<SkillEntry>) -> Vec<SkillEntry> {
    let mut deduped: HashMap<String, SkillEntry> = HashMap::new();
    for skill in skills {
        let key = skill.identity();
        match deduped.remove(&key) {
            Some(current) => {
                deduped.insert(key, prefer_skill(current, skill));
            }
            None => {
                deduped.insert(key, skill);
            }
        }
    }

    let mut result = deduped.into_values().collect::<Vec<_>>();
    result.sort_by(|left, right| {
        left.source_priority
            .cmp(&right.source_priority)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.path.cmp(&right.path))
    });
    result
}

fn prefer_skill(left: SkillEntry, right: SkillEntry) -> SkillEntry {
    if left.source_priority != right.source_priority {
        return if left.source_priority < right.source_priority {
            left
        } else {
            right
        };
    }
    let left_mtime = left.mtime.unwrap_or(0.0);
    let right_mtime = right.mtime.unwrap_or(0.0);
    if left_mtime != right_mtime {
        return if left_mtime > right_mtime {
            left
        } else {
            right
        };
    }
    if left.path <= right.path {
        left
    } else {
        right
    }
}

fn scan_skill_dir(
    root: &Path,
    source: &'static str,
    scope: &'static str,
    priority: i64,
) -> Vec<SkillEntry> {
    let mut children = match sorted_dir_entries(root) {
        Some(children) => children,
        None => return Vec::new(),
    };
    children.sort_by(|left, right| {
        entry_name(left)
            .to_lowercase()
            .cmp(&entry_name(right).to_lowercase())
    });

    children
        .into_iter()
        .filter(|child| entry_name(child) != ".system")
        .filter_map(|child| skill_entry(&child, source, scope, priority, None))
        .collect()
}

fn scan_plugin_dir(root: &Path, source: &'static str) -> Vec<SkillEntry> {
    let root = if root.is_absolute() {
        root.to_path_buf()
    } else {
        let Ok(current_dir) = env::current_dir() else {
            return Vec::new();
        };
        current_dir.join(root)
    };
    let plugin_roots = collect_plugin_roots(&root);
    let manifest_roots: HashSet<_> = plugin_roots
        .iter()
        .filter(|(_, has_manifest)| *has_manifest)
        .map(|(path, _)| path.clone())
        .collect();
    let mut skill_files = HashSet::new();
    let mut output = Vec::new();
    for (plugin_root, _) in plugin_roots {
        let Ok(skills) = scan_plugin_skills(&plugin_root) else {
            continue;
        };
        let (plugin_name, provider, version) = plugin_metadata(&root, &plugin_root);
        for skill in skills {
            let Some(relative) = skill["path"].as_str() else {
                continue;
            };
            let directory = if relative == "." {
                plugin_root.clone()
            } else {
                plugin_root.join(relative)
            };
            let owner = directory
                .ancestors()
                .find(|path| manifest_roots.contains(*path));
            if owner.is_some_and(|owner| owner != plugin_root.as_path()) {
                continue;
            }
            let skill_md = directory.join("SKILL.md");
            if !skill_files.insert(skill_md.clone()) {
                continue;
            }
            output.push(SkillEntry {
                name: skill["name"].as_str().unwrap_or_default().to_owned(),
                description: skill["description"].as_str().unwrap_or_default().to_owned(),
                path: skill_md.to_string_lossy().into_owned(),
                source,
                scope: "user",
                source_priority: plugin_source_priority(provider.as_deref()),
                plugin_name: Some(plugin_name.clone()),
                plugin_provider: provider.clone(),
                plugin_version: version.clone(),
                mtime: file_mtime(&skill_md),
            });
        }
    }
    output
}

fn collect_plugin_roots(root: &Path) -> Vec<(PathBuf, bool)> {
    let mut pending = vec![(root.to_path_buf(), None, false)];
    let mut ancestors = HashSet::new();
    let mut output = Vec::new();
    while let Some((directory, owner, leaving)) = pending.pop() {
        if leaving {
            ancestors.remove(&directory);
            continue;
        }
        if !directory.is_dir() {
            continue;
        }
        let has_manifest = PLUGIN_MANIFEST_PATHS
            .iter()
            .any(|relative| fs::symlink_metadata(directory.join(relative)).is_ok());
        let is_plugin_root =
            has_manifest || (owner != Some(true) && directory.join("skills").is_dir());
        // Only configured collection anchors and plugin roots may be links.
        if directory.is_symlink() && directory != root && (owner.is_some() || !is_plugin_root) {
            continue;
        }
        let Ok(canonical) = fs::canonicalize(&directory) else {
            continue;
        };
        if !ancestors.insert(canonical.clone()) {
            continue;
        }
        let owner = if is_plugin_root {
            output.push((directory.clone(), has_manifest));
            Some(has_manifest)
        } else {
            owner
        };
        pending.push((canonical, None, true));
        if let Some(mut children) = sorted_dir_entries(&directory) {
            children.sort();
            pending.extend(children.into_iter().rev().map(|path| (path, owner, false)));
        }
    }
    output
}

fn skill_entry(
    skill_dir: &Path,
    source: &'static str,
    scope: &'static str,
    priority: i64,
    plugin_name: Option<String>,
) -> Option<SkillEntry> {
    if !skill_dir.is_dir() {
        return None;
    }
    let skill_md = skill_dir.join("SKILL.md");
    if !skill_md.is_file() {
        return None;
    }

    let metadata = parse_frontmatter(&skill_md);
    let name = metadata
        .get("name")
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or_else(|| {
            skill_dir
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
    let description = metadata.get("description").cloned().unwrap_or_default();
    let mtime = file_mtime(&skill_md);

    Some(SkillEntry {
        name,
        description,
        path: skill_md.to_string_lossy().into_owned(),
        source,
        scope,
        source_priority: priority,
        plugin_name,
        plugin_provider: None,
        plugin_version: None,
        mtime,
    })
}

fn plugin_metadata(root: &Path, plugin_root: &Path) -> (String, Option<String>, Option<String>) {
    let mut plugin_name = plugin_root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    let parts = plugin_root
        .strip_prefix(root)
        .ok()
        .map(|relative| {
            relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if parts.len() >= 4 && parts[0] == "cache" {
        return (
            parts[2].clone(),
            Some(parts[1].clone()),
            Some(parts[3].clone()),
        );
    }
    if let Some(first) = parts.first() {
        plugin_name = first.clone();
    }
    (plugin_name, None, None)
}

fn plugin_source_priority(provider: Option<&str>) -> i64 {
    match provider.unwrap_or("") {
        "openai-curated-remote" => 20,
        "openai-bundled" | "openai-primary-runtime" => 30,
        "openai-curated" => 40,
        _ => 50,
    }
}

fn parse_frontmatter(path: &Path) -> HashMap<String, String> {
    let content = match fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => return HashMap::new(),
    };
    parse_frontmatter_content(&content)
}

/// Parse already-decoded content with the local skill frontmatter rules.
pub(super) fn parse_frontmatter_content(content: &str) -> HashMap<String, String> {
    let mut metadata = HashMap::new();
    let lines = content.split('\n').collect::<Vec<_>>();
    if lines.first().map(|line| line.trim()) != Some("---") {
        return metadata;
    }

    let mut frontmatter = Vec::new();
    for line in &lines[1..] {
        if line.trim() == "---" {
            break;
        }
        frontmatter.push(*line);
    }

    let mut index = 0;
    while index < frontmatter.len() {
        let line = frontmatter[index];
        let stripped = line.trim();
        if stripped.is_empty() || stripped.starts_with('#') || !line.contains(':') {
            index += 1;
            continue;
        }
        let current_indent = leading_spaces(line);
        let (raw_key, raw_value) = split_once_colon(line);
        let key = raw_key.trim().to_owned();
        let raw_value = raw_value.trim().to_owned();
        if key.is_empty() {
            index += 1;
            continue;
        }

        if raw_value == "|"
            || raw_value == ">"
            || raw_value.starts_with('|')
            || raw_value.starts_with('>')
        {
            let style = raw_value.chars().next().unwrap_or('|');
            let mut block_lines = Vec::new();
            index += 1;
            while index < frontmatter.len() {
                let next_line = frontmatter[index];
                let next_stripped = next_line.trim();
                let next_indent = leading_spaces(next_line);
                if !next_stripped.is_empty()
                    && next_indent <= current_indent
                    && next_line.contains(':')
                {
                    break;
                }
                block_lines.push(next_line);
                index += 1;
            }
            metadata.insert(key, normalize_block_scalar(&block_lines, style));
            continue;
        }

        metadata.insert(key, strip_quotes(&raw_value));
        index += 1;
    }

    metadata
}

fn normalize_block_scalar(lines: &[&str], style: char) -> String {
    let trim_indent = lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| leading_spaces(line))
        .min()
        .unwrap_or(0);
    let values = lines
        .iter()
        .map(|line| {
            if char_len(line) >= trim_indent {
                char_slice_from(line, trim_indent)
            } else {
                (*line).to_owned()
            }
        })
        .collect::<Vec<_>>();

    if style == '>' {
        let mut paragraphs = Vec::new();
        let mut current = Vec::new();
        for line in &values {
            if !line.trim().is_empty() {
                current.push(line.trim().to_owned());
                continue;
            }
            if !current.is_empty() {
                paragraphs.push(current.join(" "));
                current.clear();
            }
        }
        if !current.is_empty() {
            paragraphs.push(current.join(" "));
        }
        return paragraphs.join("\n").trim().to_owned();
    }

    values.join("\n").trim().to_owned()
}

fn strip_quotes(value: &str) -> String {
    let stripped = value.trim();
    let chars = stripped.chars().collect::<Vec<_>>();
    if chars.len() >= 2 {
        let first = chars[0];
        let last = chars[chars.len() - 1];
        if first == last && (first == '"' || first == '\'') {
            if first == '"' {
                if let Ok(decoded) = serde_json::from_str::<String>(stripped) {
                    return decoded;
                }
            }
            let unquoted: String = chars[1..chars.len() - 1].iter().collect();
            return if first == '\'' {
                unquoted.replace("''", "'")
            } else {
                unquoted
            };
        }
    }
    stripped.to_owned()
}

fn split_once_colon(line: &str) -> (&str, &str) {
    match line.split_once(':') {
        Some((key, value)) => (key, value),
        None => (line, ""),
    }
}

fn leading_spaces(line: &str) -> usize {
    line.chars()
        .take_while(|character| *character == ' ')
        .count()
}

fn char_len(line: &str) -> usize {
    line.chars().count()
}

fn char_slice_from(line: &str, start: usize) -> String {
    line.chars().skip(start).collect()
}

fn sorted_dir_entries(root: &Path) -> Option<Vec<PathBuf>> {
    if !root.is_dir() {
        return None;
    }
    let read_dir = fs::read_dir(root).ok()?;
    Some(
        read_dir
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect(),
    )
}

fn entry_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn file_mtime(path: &Path) -> Option<f64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs_f64())
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn codex_home_dir() -> PathBuf {
    env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".codex"))
}

fn elapsed_seconds(started_at: Instant) -> f64 {
    let elapsed = started_at.elapsed().as_secs_f64();
    (elapsed * 1_000_000.0).round() / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_inventory_file(root: &Path, relative: &str, content: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn write_inventory_manifest(root: &Path, relative: &str, manifest: Value) {
        write_inventory_file(root, relative, &manifest.to_string());
    }

    #[test]
    fn plugin_inventory_matches_shared_discovery_cases() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../shared/protocol/plugin_skill_discovery_cases.json"
        )))
        .unwrap();
        for case in cases {
            for manifest_path in PLUGIN_MANIFEST_PATHS {
                let temp = tempfile::tempdir().unwrap();
                let plugins = temp.path().join("plugins");
                let plugin = plugins.join("cache/openai-curated-remote/cache-name/1.2.3");
                write_inventory_manifest(&plugin, manifest_path, case["manifest"].clone());
                for directory in case["directories"].as_array().unwrap() {
                    fs::create_dir_all(plugin.join(directory.as_str().unwrap())).unwrap();
                }
                for file in case["files"].as_array().unwrap() {
                    write_inventory_file(&plugin, file.as_str().unwrap(), "# Skill");
                }

                let entries = scan_plugin_dir(&plugins, "codex-plugin");

                let mut paths = Vec::new();
                for entry in entries {
                    let path = Path::new(&entry.path);
                    assert!(path.is_absolute() && path.is_file());
                    assert_eq!(path.file_name().unwrap(), "SKILL.md");
                    let relative = path.parent().unwrap().strip_prefix(&plugin).unwrap();
                    paths.push(if relative.as_os_str().is_empty() {
                        ".".to_owned()
                    } else {
                        relative.to_string_lossy().replace('\\', "/")
                    });
                    assert_eq!(entry.source, "codex-plugin");
                    if paths.last().unwrap() == "." {
                        assert_eq!(entry.name, "example");
                    }
                }
                paths.sort();
                assert_eq!(
                    json!(paths),
                    case["paths"],
                    "{}: {manifest_path}",
                    case["name"]
                );
            }
        }
    }

    #[test]
    fn plugin_inventory_uses_codex_manifest_precedence() {
        let temp = tempfile::tempdir().unwrap();
        let plugins = temp.path().join("plugins");
        let plugin = plugins.join("example");
        for (manifest, selection) in PLUGIN_MANIFEST_PATHS.into_iter().zip(["codex", "claude"]) {
            write_inventory_manifest(&plugin, manifest, json!({"skills":selection}));
            write_inventory_file(&plugin, &format!("{selection}/SKILL.md"), "# Skill");
        }
        write_inventory_file(&plugin, "SKILL.md", "# Root");
        write_inventory_file(&plugin, "codex/references/example/SKILL.md", "# Reference");

        let entries = scan_plugin_dir(&plugins, "codex-plugin");

        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].path,
            plugin.join("codex/SKILL.md").to_string_lossy()
        );
        write_inventory_manifest(&plugin, PLUGIN_MANIFEST_PATHS[0], json!({"skills":[]}));
        assert!(scan_plugin_dir(&plugins, "codex-plugin").is_empty());
        fs::remove_file(plugin.join(PLUGIN_MANIFEST_PATHS[0])).unwrap();
        let entries = scan_plugin_dir(&plugins, "codex-plugin");
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].path,
            plugin.join("claude/SKILL.md").to_string_lossy()
        );
    }

    #[test]
    fn plugin_inventory_uses_nearest_manifest_root() {
        let temp = tempfile::tempdir().unwrap();
        let plugins = temp.path().join("plugins");
        let parent = plugins.join("cache/provider/package/3.0");
        let child = parent.join("skills/nested");
        write_inventory_manifest(&parent, PLUGIN_MANIFEST_PATHS[0], json!({}));
        write_inventory_file(&parent, "skills/parent/SKILL.md", "# Parent");
        write_inventory_manifest(&child, PLUGIN_MANIFEST_PATHS[1], json!({"skills":"review"}));
        write_inventory_file(&child, "SKILL.md", "# Excluded root");
        write_inventory_file(&child, "review/SKILL.md", "# Review");
        write_inventory_file(&child, "review/references/example/SKILL.md", "# Reference");

        let entries = scan_plugin_dir(&plugins, "codex-plugin");

        let paths: HashSet<_> = entries
            .iter()
            .map(|entry| PathBuf::from(&entry.path))
            .collect();
        assert_eq!(
            paths,
            HashSet::from([
                parent.join("skills/parent/SKILL.md"),
                child.join("review/SKILL.md"),
            ])
        );
        assert_eq!(entries.len(), 2);
        for entry in entries {
            assert_eq!(entry.plugin_name.as_deref(), Some("package"));
            assert_eq!(entry.plugin_provider.as_deref(), Some("provider"));
            assert_eq!(entry.plugin_version.as_deref(), Some("3.0"));
        }
    }

    #[test]
    fn plugin_inventory_preserves_provider_version_and_priority() {
        let temp = tempfile::tempdir().unwrap();
        let plugins = temp.path().join("plugins");
        for (provider, version) in [
            ("openai-curated-remote", "old"),
            ("openai-curated-remote", "new"),
            ("openai-bundled", "1.0"),
            ("openai-primary-runtime", "2.0"),
            ("openai-curated", "3.0"),
            ("third-party", "4.0"),
        ] {
            let plugin = plugins
                .join("cache")
                .join(provider)
                .join("reviewer")
                .join(version);
            write_inventory_manifest(&plugin, PLUGIN_MANIFEST_PATHS[0], json!({}));
            write_inventory_file(
                &plugin,
                "SKILL.md",
                "---\nname: Shared\ndescription: 'It''s ready.'\n---\n",
            );
            let seconds = if version == "new" { 2000 } else { 1000 };
            fs::OpenOptions::new()
                .write(true)
                .open(plugin.join("SKILL.md"))
                .unwrap()
                .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(seconds))
                .unwrap();
        }

        let entries = scan_plugin_dir(&plugins, "codex-plugin");

        assert_eq!(entries.len(), 6);
        for entry in &entries {
            let provider = entry.plugin_provider.as_deref().unwrap();
            let expected = match provider {
                "openai-curated-remote" => 20,
                "openai-bundled" | "openai-primary-runtime" => 30,
                "openai-curated" => 40,
                "third-party" => 50,
                _ => panic!("Unexpected provider: {provider}"),
            };
            assert_eq!(entry.source_priority, expected);
            assert_eq!(entry.description, "It's ready.");
            assert_eq!(entry.plugin_name.as_deref(), Some("reviewer"));
            assert!(entry.mtime.is_some());
            assert_eq!(
                entry.to_json()["plugin_version"],
                entry.plugin_version.as_deref().unwrap()
            );
        }
        let entries = deduplicate_and_sort(entries);
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].plugin_provider.as_deref(),
            Some("openai-curated-remote")
        );
        assert_eq!(entries[0].plugin_version.as_deref(), Some("new"));
        assert_eq!(entries[0].mtime, Some(2000.0));
    }

    #[test]
    fn standalone_skills_and_manifest_free_nested_defaults_remain_listed() {
        let temp = tempfile::tempdir().unwrap();
        let user = temp.path().join("skills");
        let plugins = temp.path().join("plugins");
        for relative in ["shared/SKILL.md", ".system/system/SKILL.md"] {
            write_inventory_file(&user, relative, "# Standalone");
        }
        let legacy = plugins.join("legacy-folder");
        write_inventory_file(&legacy, "skills/group/SKILL.md", "# Group");
        write_inventory_file(&legacy, "skills/group/child/SKILL.md", "# Child");
        write_inventory_file(&legacy, "skills/group/skills/leaf/SKILL.md", "# Leaf");
        write_inventory_file(&legacy, "vendor/addon/skills/addon/SKILL.md", "# Addon");
        write_inventory_file(&legacy, "skills/shared/SKILL.md", "# Duplicate");
        write_inventory_file(&legacy, "docs/SKILL.md", "# Excluded");
        write_inventory_file(&plugins, "unregistered/SKILL.md", "# Excluded");
        let mut entries = scan_skill_dir(&user, "codex", "user", CODEX_USER_PRIORITY);
        entries.extend(scan_skill_dir(
            &user.join(".system"),
            "codex",
            "system",
            CODEX_SYSTEM_PRIORITY,
        ));
        entries.extend(scan_plugin_dir(&plugins, "codex-plugin"));

        let entries = deduplicate_and_sort(entries);

        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["shared", "system", "addon", "child", "group", "leaf"]
        );
        assert_eq!(
            entries[0].path,
            user.join("shared/SKILL.md").to_string_lossy()
        );
        assert_eq!(entries[0].scope, "user");
        assert_eq!(entries[1].scope, "system");
        assert!(entries[0].plugin_name.is_none() && entries[1].plugin_name.is_none());
        assert_eq!(
            entries[3].path,
            legacy.join("skills/group/child/SKILL.md").to_string_lossy()
        );
        assert_eq!(entries[2].plugin_name.as_deref(), Some("legacy-folder"));
        assert!(entries[2].plugin_provider.is_none() && entries[2].plugin_version.is_none());
        assert_eq!(entries[2].source_priority, 50);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn plugin_inventory_keeps_linked_roots_and_cache_alias_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let plugins = temp.path().join("plugins");
        let external = temp.path().join("external");
        write_inventory_manifest(&external, PLUGIN_MANIFEST_PATHS[0], json!({}));
        write_inventory_file(&external, "SKILL.md", "# Root");
        write_inventory_file(&external, "docs/SKILL.md", "# Excluded");
        for provider in ["openai-curated-remote", "third-party"] {
            let alias = plugins
                .join("cache")
                .join(provider)
                .join("linked")
                .join("7.0");
            fs::create_dir_all(alias.parent().unwrap()).unwrap();
            crate::directory_link::create(&external, &alias).unwrap();
        }

        let entries = scan_plugin_dir(&plugins, "codex-plugin");

        assert_eq!(entries.len(), 2);
        for entry in &entries {
            assert!(entry.path.starts_with(plugins.to_str().unwrap()));
            assert_eq!(entry.plugin_name.as_deref(), Some("linked"));
            assert_eq!(entry.plugin_version.as_deref(), Some("7.0"));
        }
        assert_eq!(
            deduplicate_and_sort(entries)[0].plugin_provider.as_deref(),
            Some("openai-curated-remote")
        );
        let legacy = plugins.join("legacy-link");
        fs::remove_file(external.join(PLUGIN_MANIFEST_PATHS[0])).unwrap();
        write_inventory_file(&external, "skills/group/child/SKILL.md", "# Child");
        crate::directory_link::create(&external, &legacy).unwrap();
        assert!(scan_plugin_dir(&plugins, "codex-plugin")
            .iter()
            .any(|entry| {
                entry.path == legacy.join("skills/group/child/SKILL.md").to_string_lossy()
            }));
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn plugin_inventory_rejects_directory_link_escapes_and_cycles() {
        for relative in [
            "skills",
            "skills/escape",
            "skills/loop",
            "custom",
            ".codex-plugin",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let plugins = temp.path().join("plugins");
            let unsafe_plugin = plugins.join("unsafe");
            let external = temp.path().join("external");
            write_inventory_manifest(&external, PLUGIN_MANIFEST_PATHS[0], json!({}));
            write_inventory_file(&external, "skills/external/SKILL.md", "# External");
            write_inventory_manifest(
                &unsafe_plugin,
                PLUGIN_MANIFEST_PATHS[0],
                json!({"skills":"custom"}),
            );
            write_inventory_file(&unsafe_plugin, "skills/valid/SKILL.md", "# Valid");
            write_inventory_file(
                &plugins.join("healthy"),
                "skills/healthy/SKILL.md",
                "# Healthy",
            );
            let link = unsafe_plugin.join(relative);
            if link.exists() {
                fs::remove_dir_all(&link).unwrap();
            }
            let destination = if relative == "skills/loop" {
                unsafe_plugin.join("skills")
            } else if relative == ".codex-plugin" {
                external.join(".codex-plugin")
            } else {
                external
            };
            crate::directory_link::create(&destination, &link).unwrap();
            crate::directory_link::create(&plugins, &plugins.join("collection-cycle")).unwrap();

            let entries = scan_plugin_dir(&plugins, "codex-plugin");

            assert_eq!(entries.len(), 1, "{relative}");
            assert_eq!(entries[0].name, "healthy", "{relative}");
        }
    }

    #[test]
    fn parse_frontmatter_decodes_quoted_scalars_with_legacy_fallback() {
        for (value, expected) in [
            (
                r#""Use \"USB attach\" at C:\\tools.""#,
                r#"Use "USB attach" at C:\tools."#,
            ),
            (
                "'Use ''USB attach''; it''s ready.'",
                "Use 'USB attach'; it's ready.",
            ),
            (r#""Legacy \q USB trigger""#, r#"Legacy \q USB trigger"#),
        ] {
            let content = format!("---\ndescription: {value}\n---\n");

            let metadata = parse_frontmatter_content(&content);

            assert_eq!(
                metadata.get("description").map(String::as_str),
                Some(expected),
                "value={value}",
            );
        }
    }

    #[test]
    fn parse_frontmatter_handles_literal_block_scalar() {
        let dir = temp_dir("frontmatter-literal");
        let path = dir.join("SKILL.md");
        fs::write(
            &path,
            "---\ndescription: |\n  line one\n  line two\nname: after\n---\n",
        )
        .unwrap();

        let metadata = parse_frontmatter(&path);
        assert_eq!(
            metadata.get("description").map(String::as_str),
            Some("line one\nline two")
        );
        assert_eq!(metadata.get("name").map(String::as_str), Some("after"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn parse_frontmatter_folds_folded_block_scalar() {
        let dir = temp_dir("frontmatter-folded");
        let path = dir.join("SKILL.md");
        fs::write(
            &path,
            "---\ndescription: >\n  first paragraph\n  still first\n\n  second paragraph\n---\n",
        )
        .unwrap();

        let metadata = parse_frontmatter(&path);
        assert_eq!(
            metadata.get("description").map(String::as_str),
            Some("first paragraph still first\nsecond paragraph")
        );
        fs::remove_dir_all(dir).ok();
    }

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let path = std::env::temp_dir().join(format!(
            "wegent-local-skills-{}-{}-{}",
            std::process::id(),
            label,
            nanos
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
}
