// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use flate2::{write::GzEncoder, Compression};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const ARTIFACT_VERSION: u64 = 1;
const LOCAL_GIT_ENV_VARS: &[&str] = &[
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitTreeSnapshot {
    tree_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ChangedPath {
    path: String,
    change_type: String,
    old_path: Option<String>,
}

#[derive(Debug, Clone)]
struct FileContentSnapshot {
    path: PathBuf,
    relative_path: String,
    content: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct TurnFileChangeTracker {
    workspace: PathBuf,
    task_id: i64,
    subtask_id: i64,
    executor_home: PathBuf,
    device_id: Option<String>,
    before: Option<GitTreeSnapshot>,
    active: bool,
}

impl TurnFileChangeTracker {
    pub fn new(
        workspace: PathBuf,
        task_id: i64,
        subtask_id: i64,
        executor_home: PathBuf,
        device_id: Option<&str>,
    ) -> Self {
        Self {
            workspace: resolve_path(workspace),
            task_id,
            subtask_id,
            executor_home: resolve_path(executor_home),
            device_id: device_id.map(ToOwned::to_owned),
            before: None,
            active: false,
        }
    }

    pub fn start(&mut self) -> bool {
        if !is_git_workspace(&self.workspace) {
            return false;
        }
        let Some(snapshot) = capture_tree(&self.workspace) else {
            return false;
        };
        self.before = Some(snapshot);
        self.active = true;
        true
    }

    pub fn finalize(&mut self) -> Value {
        if !self.active {
            return json!({});
        }
        self.active = false;
        let Some(before) = self.before.take() else {
            return json!({});
        };
        let Some(after) = capture_tree(&self.workspace) else {
            return json!({});
        };
        let patch = git_output(
            &self.workspace,
            [
                "diff",
                "--binary",
                "--find-renames",
                &before.tree_id,
                &after.tree_id,
            ],
            None,
            None,
        )
        .unwrap_or_default();
        if patch.is_empty() {
            return json!({});
        }

        let files = create_file_summary(&self.workspace, &before, &after);
        completion_fields_from_patch_and_files(
            &self.workspace,
            self.task_id,
            self.subtask_id,
            &self.executor_home,
            self.device_id.as_deref(),
            &patch,
            files,
        )
    }
}

#[derive(Debug, Clone)]
pub struct NativeTurnFileChangeTracker {
    workspace: PathBuf,
    task_id: i64,
    subtask_id: i64,
    executor_home: PathBuf,
    device_id: Option<String>,
    patch: Vec<u8>,
}

impl NativeTurnFileChangeTracker {
    pub fn new(
        workspace: PathBuf,
        task_id: i64,
        subtask_id: i64,
        executor_home: PathBuf,
        device_id: Option<&str>,
    ) -> Self {
        Self {
            workspace: resolve_path(workspace),
            task_id,
            subtask_id,
            executor_home: resolve_path(executor_home),
            device_id: device_id.map(ToOwned::to_owned),
            patch: Vec::new(),
        }
    }

    pub fn record_diff(&mut self, diff: &[u8]) {
        self.patch = diff.to_vec();
    }

    pub fn finalize(&mut self) -> Value {
        completion_fields_from_patch(
            &self.workspace,
            self.task_id,
            self.subtask_id,
            &self.executor_home,
            self.device_id.as_deref(),
            &self.patch,
        )
    }
}

#[derive(Debug, Clone)]
pub struct ClaudeToolFileChangeTracker {
    workspace: PathBuf,
    task_id: i64,
    subtask_id: i64,
    executor_home: PathBuf,
    device_id: Option<String>,
    git_workspace: bool,
    before_tree_by_tool: BTreeMap<String, GitTreeSnapshot>,
    before_file_by_tool: BTreeMap<String, FileContentSnapshot>,
    completed_tools: BTreeSet<String>,
    patches: Vec<Vec<u8>>,
}

impl ClaudeToolFileChangeTracker {
    pub fn new(
        workspace: PathBuf,
        task_id: i64,
        subtask_id: i64,
        executor_home: PathBuf,
        device_id: Option<&str>,
    ) -> Self {
        let workspace = resolve_path(workspace);
        Self {
            git_workspace: is_git_workspace(&workspace),
            workspace,
            task_id,
            subtask_id,
            executor_home: resolve_path(executor_home),
            device_id: device_id.map(ToOwned::to_owned),
            before_tree_by_tool: BTreeMap::new(),
            before_file_by_tool: BTreeMap::new(),
            completed_tools: BTreeSet::new(),
            patches: Vec::new(),
        }
    }

    pub fn record_tool_use_start(&mut self, tool_name: &str, tool_use_id: &str, input: &Value) {
        if matches!(tool_name, "Write" | "Edit" | "MultiEdit" | "NotebookEdit") {
            self.pre_tool_use(input, Some(tool_use_id));
        }
    }

    pub fn record_tool_result(&mut self, tool_use_id: &str, is_error: bool) {
        if is_error {
            self.before_tree_by_tool.remove(tool_use_id);
            self.before_file_by_tool.remove(tool_use_id);
            return;
        }
        self.post_tool_use(&json!({"tool_use_id": tool_use_id}), Some(tool_use_id));
    }

    pub fn pre_tool_use(&mut self, input: &Value, tool_use_id: Option<&str>) {
        let Some(tool_use_id) = resolve_tool_use_id(input, tool_use_id) else {
            return;
        };
        if self.completed_tools.contains(&tool_use_id) {
            return;
        }

        if self.git_workspace {
            if let Some(tree) = capture_tree(&self.workspace) {
                self.before_tree_by_tool.insert(tool_use_id, tree);
            }
        } else if let Some(snapshot) = self.capture_tool_file(input) {
            self.before_file_by_tool.insert(tool_use_id, snapshot);
        }
    }

    pub fn post_tool_use(&mut self, input: &Value, tool_use_id: Option<&str>) {
        let Some(tool_use_id) = resolve_tool_use_id(input, tool_use_id) else {
            return;
        };
        if self.completed_tools.contains(&tool_use_id) {
            return;
        }

        let patch = if self.git_workspace {
            self.before_tree_by_tool
                .remove(&tool_use_id)
                .and_then(|before| {
                    let after = capture_tree(&self.workspace)?;
                    git_output(
                        &self.workspace,
                        [
                            "diff",
                            "--binary",
                            "--full-index",
                            "--find-renames",
                            &before.tree_id,
                            &after.tree_id,
                        ],
                        None,
                        None,
                    )
                    .ok()
                })
        } else {
            self.before_file_by_tool
                .remove(&tool_use_id)
                .map(|before| create_file_patch(&before))
        };

        self.completed_tools.insert(tool_use_id);
        if let Some(patch) = patch.filter(|patch| !patch.is_empty()) {
            self.patches.push(patch);
        }
    }

    pub fn finalize(&mut self) -> Value {
        if self.patches.is_empty() {
            return json!({});
        }
        let mut patch = Vec::new();
        for item in self.patches.iter().rev() {
            if !patch.is_empty() {
                patch.push(b'\n');
            }
            patch.extend_from_slice(item);
        }
        completion_fields_from_patch(
            &self.workspace,
            self.task_id,
            self.subtask_id,
            &self.executor_home,
            self.device_id.as_deref(),
            &patch,
        )
    }

    fn capture_tool_file(&self, input: &Value) -> Option<FileContentSnapshot> {
        let raw_path = input
            .get("tool_input")
            .and_then(|tool_input| {
                tool_input
                    .get("file_path")
                    .or_else(|| tool_input.get("notebook_path"))
            })
            .or_else(|| input.get("file_path"))
            .or_else(|| input.get("notebook_path"))?
            .as_str()?;
        let path = resolve_workspace_path(&self.workspace, raw_path)?;
        let relative_path = path
            .strip_prefix(&self.workspace)
            .ok()?
            .to_string_lossy()
            .replace('\\', "/");
        let content = fs::read(&path).ok();
        Some(FileContentSnapshot {
            path,
            relative_path,
            content,
        })
    }
}

fn completion_fields_from_patch(
    workspace: &Path,
    task_id: i64,
    subtask_id: i64,
    executor_home: &Path,
    device_id: Option<&str>,
    patch: &[u8],
) -> Value {
    if patch.is_empty() {
        return json!({});
    }
    let files = summarize_patch(workspace, patch);
    if files.is_empty() {
        return json!({});
    }
    completion_fields_from_patch_and_files(
        workspace,
        task_id,
        subtask_id,
        executor_home,
        device_id,
        patch,
        files,
    )
}

fn completion_fields_from_patch_and_files(
    workspace: &Path,
    task_id: i64,
    subtask_id: i64,
    executor_home: &Path,
    device_id: Option<&str>,
    patch: &[u8],
    files: Vec<Value>,
) -> Value {
    if files.is_empty() {
        return json!({});
    }
    persist_artifact(workspace, task_id, subtask_id, executor_home, patch);
    json!({
        "file_changes": {
            "version": ARTIFACT_VERSION,
            "status": "active",
            "artifact_id": format!("turn-file-changes/{task_id}/{subtask_id}"),
            "device_id": device_id,
            "workspace_path": workspace.display().to_string(),
            "file_count": files.len(),
            "additions": files.iter().map(|item| item["additions"].as_i64().unwrap_or(0)).sum::<i64>(),
            "deletions": files.iter().map(|item| item["deletions"].as_i64().unwrap_or(0)).sum::<i64>(),
            "files": files,
            "reverted_at": null,
        }
    })
}

fn persist_artifact(
    workspace: &Path,
    task_id: i64,
    subtask_id: i64,
    executor_home: &Path,
    patch: &[u8],
) {
    let artifact_id = format!("turn-file-changes/{task_id}/{subtask_id}");
    let artifact_dir = executor_home.join("artifacts").join(&artifact_id);
    let _ = fs::create_dir_all(&artifact_dir);
    let checksum = format!("{:x}", Sha256::digest(patch));
    let metadata = json!({
        "version": ARTIFACT_VERSION,
        "task_id": task_id,
        "subtask_id": subtask_id,
        "workspace_path": workspace.display().to_string(),
        "checksum": checksum,
    });
    atomic_write(&artifact_dir.join("changes.patch.gz"), &gzip_bytes(patch));
    atomic_write(
        &artifact_dir.join("metadata.json"),
        serde_json::to_vec(&metadata).unwrap_or_default().as_slice(),
    );
}

fn summarize_patch(workspace: &Path, patch: &[u8]) -> Vec<Value> {
    let changed_by_path = changed_paths_from_patch(patch);
    let stat_by_path = numstat_by_path(workspace, patch);
    changed_by_path
        .into_values()
        .map(|changed| {
            let (additions, deletions, binary) = stat_by_path
                .get(&changed.path)
                .copied()
                .unwrap_or((0, 0, false));
            file_summary_value(changed, additions, deletions, binary)
        })
        .collect()
}

fn create_file_summary(
    workspace: &Path,
    before: &GitTreeSnapshot,
    after: &GitTreeSnapshot,
) -> Vec<Value> {
    let mut files = changed_paths(workspace, before, after)
        .into_iter()
        .map(|changed| {
            let (additions, deletions, binary) = line_stats(workspace, before, after, &changed);
            file_summary_value(changed, additions, deletions, binary)
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
    files
}

fn file_summary_value(changed: ChangedPath, additions: i64, deletions: i64, binary: bool) -> Value {
    json!({
        "old_path": changed.old_path,
        "path": changed.path,
        "change_type": changed.change_type,
        "additions": additions,
        "deletions": deletions,
        "binary": binary,
    })
}

fn capture_tree(workspace: &Path) -> Option<GitTreeSnapshot> {
    let temp_dir = unique_temp_dir("wegent-turn-index");
    let index_path = temp_dir.join("index");
    let mut env = BTreeMap::new();
    env.insert(
        "GIT_INDEX_FILE".to_owned(),
        index_path.display().to_string(),
    );
    if has_head(workspace) {
        git_output(workspace, ["read-tree", "HEAD"], Some(&env), None).ok()?;
    }
    git_output(workspace, ["add", "--all", "--", "."], Some(&env), None).ok()?;
    let tree_id =
        String::from_utf8_lossy(&git_output(workspace, ["write-tree"], Some(&env), None).ok()?)
            .trim()
            .to_owned();
    let _ = fs::remove_dir_all(temp_dir);
    Some(GitTreeSnapshot { tree_id })
}

fn changed_paths(
    workspace: &Path,
    before: &GitTreeSnapshot,
    after: &GitTreeSnapshot,
) -> Vec<ChangedPath> {
    let output = git_output(
        workspace,
        [
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            &before.tree_id,
            &after.tree_id,
        ],
        None,
        None,
    )
    .unwrap_or_default();
    let tokens = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut changes = Vec::new();
    let mut index = 0;
    while index < tokens.len() && !tokens[index].is_empty() {
        let status = decode_path(tokens[index]);
        index += 1;
        if index >= tokens.len() {
            break;
        }
        let first_path = decode_path(tokens[index]);
        index += 1;
        if status.starts_with('R') {
            if index >= tokens.len() {
                break;
            }
            let new_path = decode_path(tokens[index]);
            index += 1;
            changes.push(ChangedPath {
                old_path: Some(first_path),
                path: new_path,
                change_type: "renamed".to_owned(),
            });
        } else {
            let change_type = match status.chars().next() {
                Some('A') => "created",
                Some('D') => "deleted",
                _ => "modified",
            };
            changes.push(ChangedPath {
                old_path: None,
                path: first_path,
                change_type: change_type.to_owned(),
            });
        }
    }
    changes
}

fn line_stats(
    workspace: &Path,
    before: &GitTreeSnapshot,
    after: &GitTreeSnapshot,
    changed: &ChangedPath,
) -> (i64, i64, bool) {
    let mut args = vec![
        "diff".to_owned(),
        "--numstat".to_owned(),
        "--find-renames".to_owned(),
        before.tree_id.clone(),
        after.tree_id.clone(),
        "--".to_owned(),
    ];
    if let Some(old_path) = &changed.old_path {
        args.push(old_path.clone());
    }
    args.push(changed.path.clone());
    parse_numstat(&git_output_vec(workspace, args, None, None).unwrap_or_default())
        .remove(&changed.path)
        .unwrap_or((0, 0, false))
}

fn numstat_by_path(workspace: &Path, patch: &[u8]) -> BTreeMap<String, (i64, i64, bool)> {
    let patch_path = unique_temp_dir("wegent-turn-numstat").join("changes.patch");
    let _ = fs::write(&patch_path, patch);
    let mut command = Command::new("git");
    clear_local_git_env(&mut command);
    let result = command
        .arg("apply")
        .arg("--numstat")
        .arg("-z")
        .arg(&patch_path)
        .current_dir(workspace)
        .output();
    let _ = fs::remove_file(&patch_path);
    result
        .ok()
        .filter(|output| output.status.success())
        .map(|output| parse_numstat(&output.stdout))
        .unwrap_or_default()
}

fn parse_numstat(output: &[u8]) -> BTreeMap<String, (i64, i64, bool)> {
    if !output.contains(&0) {
        return output
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .filter_map(parse_numstat_record)
            .collect();
    }

    let mut stats = BTreeMap::new();
    for token in output.split(|byte| *byte == 0) {
        if token.is_empty() {
            continue;
        }
        if let Some((path, stat)) = parse_numstat_record(token) {
            stats.insert(path, stat);
        }
    }
    stats
}

fn parse_numstat_record(token: &[u8]) -> Option<(String, (i64, i64, bool))> {
    let parts = token.split(|byte| *byte == b'\t').collect::<Vec<_>>();
    if parts.len() < 3 {
        return None;
    }
    let path = decode_path(parts[parts.len() - 1]);
    let binary = parts[0] == b"-" || parts[1] == b"-";
    let additions = if binary {
        0
    } else {
        parse_i64(parts[0]).unwrap_or(0)
    };
    let deletions = if binary {
        0
    } else {
        parse_i64(parts[1]).unwrap_or(0)
    };
    Some((path, (additions, deletions, binary)))
}

fn changed_paths_from_patch(patch: &[u8]) -> BTreeMap<String, ChangedPath> {
    let mut changes = BTreeMap::new();
    let mut current_path: Option<String> = None;
    let mut old_path: Option<String> = None;
    let mut change_type = "modified".to_owned();
    for line in String::from_utf8_lossy(patch).lines() {
        if line.starts_with("diff --git ") {
            store_patch_change(
                &mut changes,
                current_path.take(),
                old_path.take(),
                &change_type,
            );
            let (new_path, previous_path) = paths_from_diff_header(line);
            current_path = new_path;
            old_path = previous_path;
            change_type = "modified".to_owned();
        } else if line.starts_with("new file mode ") {
            change_type = "created".to_owned();
        } else if line.starts_with("deleted file mode ") {
            change_type = "deleted".to_owned();
        } else if line.starts_with("rename from ") {
            old_path = Some(line.trim_start_matches("rename from ").trim().to_owned());
            change_type = "renamed".to_owned();
        } else if line.starts_with("rename to ") {
            current_path = Some(line.trim_start_matches("rename to ").trim().to_owned());
            change_type = "renamed".to_owned();
        }
    }
    store_patch_change(&mut changes, current_path, old_path, &change_type);
    changes
}

fn store_patch_change(
    changes: &mut BTreeMap<String, ChangedPath>,
    path: Option<String>,
    old_path: Option<String>,
    change_type: &str,
) {
    let Some(path) = path else {
        return;
    };
    changes.insert(
        path.clone(),
        ChangedPath {
            path,
            old_path: (change_type == "renamed").then_some(old_path).flatten(),
            change_type: change_type.to_owned(),
        },
    );
}

fn paths_from_diff_header(line: &str) -> (Option<String>, Option<String>) {
    let parts = line.split(' ').collect::<Vec<_>>();
    if parts.len() < 4 {
        return (None, None);
    }
    (
        Some(strip_diff_prefix(parts[3])),
        Some(strip_diff_prefix(parts[2])),
    )
}

fn strip_diff_prefix(path: &str) -> String {
    path.strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(path)
        .to_owned()
}

fn create_file_patch(before: &FileContentSnapshot) -> Vec<u8> {
    let after = fs::read(&before.path).ok();
    if before.content == after
        || is_binary(before.content.as_deref())
        || is_binary(after.as_deref())
    {
        return Vec::new();
    }
    unified_file_patch(
        &before.relative_path,
        before.content.as_deref(),
        after.as_deref(),
    )
}

fn unified_file_patch(path: &str, before: Option<&[u8]>, after: Option<&[u8]>) -> Vec<u8> {
    let mut lines = Vec::new();
    lines.push(format!("diff --git a/{path} b/{path}\n"));
    if before.is_none() {
        lines.push("new file mode 100644\n".to_owned());
        lines.push("--- /dev/null\n".to_owned());
    } else {
        lines.push(format!("--- a/{path}\n"));
    }
    if after.is_none() {
        lines.push("deleted file mode 100644\n".to_owned());
        lines.push("+++ /dev/null\n".to_owned());
    } else {
        lines.push(format!("+++ b/{path}\n"));
    }
    let before_lines = text_lines(before);
    let after_lines = text_lines(after);
    lines.push(format!(
        "@@ -1,{} +1,{} @@\n",
        before_lines.len(),
        after_lines.len()
    ));
    for line in before_lines {
        lines.push(format!("-{line}"));
    }
    for line in after_lines {
        lines.push(format!("+{line}"));
    }
    lines.concat().into_bytes()
}

fn text_lines(content: Option<&[u8]>) -> Vec<String> {
    let Some(content) = content else {
        return Vec::new();
    };
    String::from_utf8_lossy(content)
        .split_inclusive('\n')
        .map(ToOwned::to_owned)
        .collect()
}

fn is_binary(content: Option<&[u8]>) -> bool {
    content.is_some_and(|content| content.contains(&0))
}

fn resolve_tool_use_id(input: &Value, explicit: Option<&str>) -> Option<String> {
    explicit
        .map(ToOwned::to_owned)
        .or_else(|| input.get("tool_use_id")?.as_str().map(ToOwned::to_owned))
}

fn resolve_workspace_path(workspace: &Path, raw_path: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(raw_path);
    let path = if candidate.is_absolute() {
        candidate
    } else {
        workspace.join(candidate)
    };
    let resolved = resolve_path(path);
    resolved.strip_prefix(workspace).ok()?;
    Some(resolved)
}

fn is_git_workspace(workspace: &Path) -> bool {
    let Ok(output) = git_output(
        workspace,
        ["rev-parse", "--is-inside-work-tree"],
        None,
        None,
    ) else {
        return false;
    };
    String::from_utf8_lossy(&output).trim() == "true"
}

fn has_head(workspace: &Path) -> bool {
    git_output(workspace, ["rev-parse", "--verify", "HEAD"], None, None).is_ok()
}

fn git_output<const N: usize>(
    workspace: &Path,
    args: [&str; N],
    env: Option<&BTreeMap<String, String>>,
    input: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    git_output_vec(
        workspace,
        args.into_iter().map(ToOwned::to_owned).collect(),
        env,
        input,
    )
}

fn git_output_vec(
    workspace: &Path,
    args: Vec<String>,
    env: Option<&BTreeMap<String, String>>,
    input: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    clear_local_git_env(&mut command);
    command.arg("-C").arg(workspace).args(args);
    if let Some(env) = env {
        command.envs(env);
    }
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    if let Some(input) = input {
        child
            .stdin
            .as_mut()
            .ok_or_else(|| "failed to open git stdin".to_owned())?
            .write_all(input)
            .map_err(|error| error.to_string())?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

fn clear_local_git_env(command: &mut Command) {
    for key in LOCAL_GIT_ENV_VARS {
        command.env_remove(key);
    }
}

fn gzip_bytes(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    let _ = encoder.write_all(bytes);
    encoder.finish().unwrap_or_default()
}

fn atomic_write(path: &Path, content: &[u8]) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let temp_path = path.with_extension(format!(
        "tmp-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    ));
    let _ = fs::write(&temp_path, content);
    let _ = fs::rename(temp_path, path);
}

fn unique_temp_dir(prefix: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "{prefix}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    ));
    let _ = fs::create_dir_all(&path);
    path
}

fn resolve_path(path: PathBuf) -> PathBuf {
    path.canonicalize().unwrap_or(path)
}

fn decode_path(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

fn parse_i64(bytes: &[u8]) -> Option<i64> {
    std::str::from_utf8(bytes).ok()?.parse::<i64>().ok()
}
