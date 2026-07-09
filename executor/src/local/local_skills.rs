// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Native implementation of the `ls_skills` device command. Scans the local
//! Codex skill directories, parses each `SKILL.md` frontmatter, deduplicates by
//! name and returns the same JSON array shape the previous embedded Python
//! script produced.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::{Instant, UNIX_EPOCH},
};

use serde_json::{json, Value};

use crate::local::command::CommandResult;

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
    let skills =
        tokio::task::spawn_blocking(collect_skills)
            .await
            .unwrap_or_default();
    let stdout = Value::Array(skills.iter().map(SkillEntry::to_json).collect());
    CommandResult {
        success: true,
        exit_code: Some(0),
        stdout,
        stderr: String::new(),
        duration: elapsed_seconds(started_at),
        timed_out: false,
        stdout_truncated: false,
        stderr_truncated: false,
        error: None,
    }
}

fn collect_skills() -> Vec<SkillEntry> {
    let home = home_dir();
    let codex_skills_root = home.join(".codex").join("skills");

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
    skills.extend(scan_plugin_dir(
        &home.join(".codex").join("plugins"),
        "codex-plugin",
    ));

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
        return if left_mtime > right_mtime { left } else { right };
    }
    if left.path <= right.path {
        left
    } else {
        right
    }
}

fn scan_skill_dir(root: &Path, source: &'static str, scope: &'static str, priority: i64) -> Vec<SkillEntry> {
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
    if !root.is_dir() {
        return Vec::new();
    }

    let mut skill_files = Vec::new();
    collect_skill_md_files(root, &mut skill_files);
    skill_files.sort_by(|left, right| {
        left.to_string_lossy()
            .to_lowercase()
            .cmp(&right.to_string_lossy().to_lowercase())
    });

    let mut output = Vec::new();
    for skill_md in skill_files {
        let skill_dir = match skill_md.parent() {
            Some(dir) => dir.to_path_buf(),
            None => continue,
        };
        // Only skills that live directly under a `skills` directory are valid.
        if skill_dir
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some("skills")
        {
            continue;
        }

        let (plugin_name, provider, version) = plugin_metadata(root, &skill_dir);
        if let Some(mut entry) = skill_entry(
            &skill_dir,
            source,
            "user",
            plugin_source_priority(provider.as_deref()),
            Some(plugin_name),
        ) {
            entry.plugin_provider = provider;
            entry.plugin_version = version;
            output.push(entry);
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
    let description = metadata
        .get("description")
        .cloned()
        .unwrap_or_default();
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

fn plugin_metadata(root: &Path, skill_dir: &Path) -> (String, Option<String>, Option<String>) {
    // skill_dir is `<plugin_root>/skills/<skill>`, so the plugin root is two
    // levels up.
    let plugin_root = skill_dir
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| skill_dir.to_path_buf());
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
    let mut metadata = HashMap::new();
    let content = match fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => return metadata,
    };
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

        if raw_value == "|" || raw_value == ">" || raw_value.starts_with('|') || raw_value.starts_with('>') {
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
            return chars[1..chars.len() - 1].iter().collect();
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
    line.chars().take_while(|character| *character == ' ').count()
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

fn collect_skill_md_files(root: &Path, output: &mut Vec<PathBuf>) {
    let Ok(read_dir) = fs::read_dir(root) else {
        return;
    };
    for entry in read_dir.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            collect_skill_md_files(&path, output);
        } else if path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
            output.push(path);
        }
    }
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
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn elapsed_seconds(started_at: Instant) -> f64 {
    let elapsed = started_at.elapsed().as_secs_f64();
    (elapsed * 1_000_000.0).round() / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_frontmatter_reads_scalar_and_quoted_values() {
        let dir = temp_dir("frontmatter-scalar");
        let path = dir.join("SKILL.md");
        fs::write(
            &path,
            "---\nname: Example Skill\ndescription: \"Quoted value\"\n---\nbody\n",
        )
        .unwrap();

        let metadata = parse_frontmatter(&path);
        assert_eq!(metadata.get("name").map(String::as_str), Some("Example Skill"));
        assert_eq!(
            metadata.get("description").map(String::as_str),
            Some("Quoted value")
        );
        fs::remove_dir_all(dir).ok();
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

    #[test]
    fn parse_frontmatter_requires_leading_marker() {
        let dir = temp_dir("frontmatter-no-marker");
        let path = dir.join("SKILL.md");
        fs::write(&path, "name: skipped\n").unwrap();
        assert!(parse_frontmatter(&path).is_empty());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn strip_quotes_removes_matching_pairs_only() {
        assert_eq!(strip_quotes("\"value\""), "value");
        assert_eq!(strip_quotes("'value'"), "value");
        assert_eq!(strip_quotes("\"value'"), "\"value'");
        assert_eq!(strip_quotes("plain"), "plain");
    }

    #[test]
    fn plugin_source_priority_matches_known_providers() {
        assert_eq!(plugin_source_priority(Some("openai-curated-remote")), 20);
        assert_eq!(plugin_source_priority(Some("openai-bundled")), 30);
        assert_eq!(plugin_source_priority(Some("openai-primary-runtime")), 30);
        assert_eq!(plugin_source_priority(Some("openai-curated")), 40);
        assert_eq!(plugin_source_priority(Some("unknown")), 50);
        assert_eq!(plugin_source_priority(None), 50);
    }

    #[test]
    fn plugin_metadata_reads_cache_layout() {
        let root = PathBuf::from("/home/user/.codex/plugins");
        let skill_dir = root.join("cache/openai-curated/my-plugin/1.2.3/skills/my-skill");
        let (name, provider, version) = plugin_metadata(&root, &skill_dir);
        assert_eq!(name, "my-plugin");
        assert_eq!(provider.as_deref(), Some("openai-curated"));
        assert_eq!(version.as_deref(), Some("1.2.3"));
    }

    #[test]
    fn plugin_metadata_falls_back_to_first_component() {
        let root = PathBuf::from("/home/user/.codex/plugins");
        let skill_dir = root.join("standalone/skills/my-skill");
        let (name, provider, version) = plugin_metadata(&root, &skill_dir);
        assert_eq!(name, "standalone");
        assert!(provider.is_none());
        assert!(version.is_none());
    }

    #[test]
    fn prefer_skill_orders_by_priority_then_mtime_then_path() {
        let low_priority = entry("skill", 0, Some(1.0), "/a");
        let high_priority = entry("skill", 10, Some(5.0), "/b");
        assert_eq!(
            prefer_skill(low_priority.clone(), high_priority.clone()).path,
            "/a"
        );

        let older = entry("skill", 5, Some(1.0), "/a");
        let newer = entry("skill", 5, Some(9.0), "/b");
        assert_eq!(prefer_skill(older.clone(), newer.clone()).path, "/b");

        let first = entry("skill", 5, Some(1.0), "/a");
        let second = entry("skill", 5, Some(1.0), "/b");
        assert_eq!(prefer_skill(first, second).path, "/a");
    }

    #[test]
    fn dedup_and_sort_prefers_stronger_source_and_orders_output() {
        let skills = vec![
            entry("Beta", 10, Some(1.0), "/beta-system"),
            entry("beta", 0, Some(1.0), "/beta-user"),
            entry("Alpha", 0, Some(1.0), "/alpha"),
        ];
        let result = deduplicate_and_sort(skills);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].path, "/alpha");
        assert_eq!(result[1].path, "/beta-user");
    }

    fn entry(name: &str, priority: i64, mtime: Option<f64>, path: &str) -> SkillEntry {
        SkillEntry {
            name: name.to_owned(),
            description: String::new(),
            path: path.to_owned(),
            source: "codex",
            scope: "user",
            source_priority: priority,
            plugin_name: None,
            plugin_provider: None,
            plugin_version: None,
            mtime,
        }
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
