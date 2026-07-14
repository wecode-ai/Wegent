// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{response::RuntimeTaskLink, store::runtime_work_dir};

const STATE_VERSION: u64 = 1;
const DEFAULT_KEEP_COUNT: usize = 15;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct WorktreeSettings {
    pub worktree_root: String,
    pub resolved_worktree_root: String,
    pub auto_cleanup_enabled: bool,
    pub keep_count: usize,
}

impl Default for WorktreeSettings {
    fn default() -> Self {
        Self {
            worktree_root: String::new(),
            resolved_worktree_root: default_worktree_root().display().to_string(),
            auto_cleanup_enabled: true,
            keep_count: DEFAULT_KEEP_COUNT,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct WorktreeSettingsPatch {
    pub worktree_root: Option<String>,
    pub auto_cleanup_enabled: Option<bool>,
    pub keep_count: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ManagedWorktree {
    pub worktree_id: String,
    pub path: String,
    pub repository_name: String,
    pub source_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub snapshot_ref: Option<String>,
    pub snapshot_commit: Option<String>,
    pub snapshot_at: Option<i64>,
    pub git_common_dir: Option<String>,
    pub state: String,
    pub last_error: Option<String>,
}

impl Default for ManagedWorktree {
    fn default() -> Self {
        let now = now_ms();
        Self {
            worktree_id: String::new(),
            path: String::new(),
            repository_name: String::new(),
            source_path: None,
            created_at: now,
            updated_at: now,
            snapshot_ref: None,
            snapshot_commit: None,
            snapshot_at: None,
            git_common_dir: None,
            state: "active".to_owned(),
            last_error: None,
        }
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct WorktreeState {
    version: u64,
    settings: WorktreeSettings,
    known_roots: Vec<String>,
    records: HashMap<String, ManagedWorktree>,
}

#[derive(Clone)]
pub(crate) struct WorktreeManager {
    state_path: PathBuf,
    mutation_lock: Arc<Mutex<()>>,
}

impl WorktreeManager {
    pub fn from_env() -> Self {
        Self::new(runtime_work_dir().join("worktrees.json"))
    }

    fn new(state_path: PathBuf) -> Self {
        Self {
            state_path,
            mutation_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn settings(&self) -> WorktreeSettings {
        self.load().settings
    }

    pub fn update_settings(
        &self,
        patch: WorktreeSettingsPatch,
    ) -> Result<WorktreeSettings, String> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| "Worktree settings lock is unavailable".to_owned())?;
        let mut state = self.load();
        let previous_root = PathBuf::from(&state.settings.resolved_worktree_root);
        if let Some(root) = patch.worktree_root {
            let normalized = normalize_configured_root(&root)?;
            state.settings.worktree_root = normalized;
        }
        if let Some(enabled) = patch.auto_cleanup_enabled {
            state.settings.auto_cleanup_enabled = enabled;
        }
        if let Some(keep_count) = patch.keep_count {
            if keep_count == 0 {
                return Err("keepCount must be at least 1".to_owned());
            }
            state.settings.keep_count = keep_count;
        }
        let resolved = resolve_worktree_root(&state.settings.worktree_root);
        ensure_safe_root(&resolved)?;
        fs::create_dir_all(&resolved)
            .map_err(|error| format!("Failed to create {}: {error}", resolved.display()))?;
        state.settings.resolved_worktree_root = resolved.display().to_string();
        remember_root(&mut state.known_roots, &previous_root);
        remember_root(&mut state.known_roots, &resolved);
        self.save(&state)?;
        Ok(state.settings)
    }

    pub fn prepare(
        &self,
        source_path: &Path,
        worktree_id: &str,
        git_ref: Option<&str>,
    ) -> Result<ManagedWorktree, String> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| "Worktree mutation lock is unavailable".to_owned())?;
        validate_worktree_id(worktree_id)?;
        let source_path = canonical_existing_dir(source_path)?;
        let repository_name = source_path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("repository")
            .to_owned();
        let mut state = self.load();
        let root = PathBuf::from(&state.settings.resolved_worktree_root);
        ensure_safe_root(&root)?;
        fs::create_dir_all(&root)
            .map_err(|error| format!("Failed to create {}: {error}", root.display()))?;
        let path = root.join(worktree_id).join(&repository_name);
        ensure_managed_path(&path, &state.known_roots)?;
        if !path.exists() {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
            }
            add_git_worktree(&source_path, &path, git_ref)?;
        }
        let key = normalized_path_key(&path);
        let now = now_ms();
        let mut record = state.records.remove(&key).unwrap_or_default();
        record.worktree_id = worktree_id.to_owned();
        record.path = path.display().to_string();
        record.repository_name = repository_name;
        record.source_path = Some(source_path.display().to_string());
        record.updated_at = now;
        record.state = "active".to_owned();
        record.last_error = None;
        state.records.insert(key, record.clone());
        remember_root(&mut state.known_roots, &root);
        self.save(&state)?;
        Ok(record)
    }

    pub fn list(
        &self,
        tasks: &[RuntimeTaskLink],
    ) -> Result<Vec<(ManagedWorktree, Vec<RuntimeTaskLink>)>, String> {
        let mut state = self.load();
        discover_worktrees(&mut state);
        let mut result = state
            .records
            .values_mut()
            .map(|record| {
                record.state = if Path::new(&record.path).exists() {
                    "active"
                } else if record.snapshot_ref.is_some() && record.git_common_dir.is_some() {
                    "restorable"
                } else {
                    "missing"
                }
                .to_owned();
                let linked = tasks
                    .iter()
                    .filter(|task| same_path(&task.workspace_path, &record.path))
                    .cloned()
                    .collect::<Vec<_>>();
                (record.clone(), linked)
            })
            .collect::<Vec<_>>();
        result.sort_by_key(|(record, _)| std::cmp::Reverse(record.updated_at));
        Ok(result)
    }

    pub fn delete(&self, path: &Path, preserve_snapshot: bool) -> Result<ManagedWorktree, String> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| "Worktree mutation lock is unavailable".to_owned())?;
        let mut state = self.load();
        discover_worktrees(&mut state);
        ensure_managed_path(path, &state.known_roots)?;
        let key = normalized_path_key(path);
        let mut record = state
            .records
            .remove(&key)
            .ok_or_else(|| "Managed worktree was not found".to_owned())?;
        if path.exists() && preserve_snapshot {
            let snapshot =
                snapshot_worktree(path, self.state_path.parent().unwrap_or(Path::new(".")))?;
            record.snapshot_ref = Some(snapshot.reference);
            record.snapshot_commit = Some(snapshot.commit);
            record.snapshot_at = Some(now_ms());
            record.git_common_dir = Some(snapshot.git_common_dir);
        }
        if path.exists() {
            remove_git_worktree(path)?;
        }
        record.state = if record.snapshot_ref.is_some() {
            "restorable"
        } else {
            "deleted"
        }
        .to_owned();
        record.updated_at = now_ms();
        record.last_error = None;
        state.records.insert(key, record.clone());
        self.save(&state)?;
        Ok(record)
    }

    pub fn restore(&self, path: &Path) -> Result<ManagedWorktree, String> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| "Worktree mutation lock is unavailable".to_owned())?;
        let mut state = self.load();
        ensure_managed_path(path, &state.known_roots)?;
        let key = normalized_path_key(path);
        let mut record = state
            .records
            .remove(&key)
            .ok_or_else(|| "Managed worktree was not found".to_owned())?;
        if path.exists() {
            record.state = "active".to_owned();
        } else {
            let reference = record
                .snapshot_ref
                .as_deref()
                .ok_or_else(|| "Worktree snapshot is unavailable".to_owned())?;
            let git_common_dir = record
                .git_common_dir
                .as_deref()
                .ok_or_else(|| "Source repository is unavailable".to_owned())?;
            restore_git_worktree(Path::new(git_common_dir), path, reference)?;
            record.state = "active".to_owned();
            record.updated_at = now_ms();
            record.last_error = None;
        }
        state.records.insert(key, record.clone());
        self.save(&state)?;
        Ok(record)
    }

    pub fn restore_if_known(&self, path: &Path) -> Result<bool, String> {
        if path.exists() {
            return Ok(false);
        }
        let state = self.load();
        if !state.records.contains_key(&normalized_path_key(path)) {
            return Ok(false);
        }
        self.restore(path).map(|_| true)
    }

    pub fn forget_if_known(&self, path: &Path) -> Result<bool, String> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| "Worktree mutation lock is unavailable".to_owned())?;
        let mut state = self.load();
        let Some(record) = state.records.remove(&normalized_path_key(path)) else {
            return Ok(false);
        };
        if let (Some(git_common_dir), Some(reference)) = (
            record.git_common_dir.as_deref(),
            record.snapshot_ref.as_deref(),
        ) {
            delete_snapshot_ref(Path::new(git_common_dir), reference)?;
        }
        self.save(&state)?;
        Ok(true)
    }

    pub fn prune(&self, tasks: &[RuntimeTaskLink]) -> Result<Vec<ManagedWorktree>, String> {
        let state = self.load();
        if !state.settings.auto_cleanup_enabled {
            return Ok(Vec::new());
        }
        let protected = tasks
            .iter()
            .filter(|task| {
                task.running || now_ms().saturating_sub(task.updated_at) < 5 * 60 * 1_000
            })
            .map(|task| normalized_path_key(Path::new(&task.workspace_path)))
            .collect::<HashSet<_>>();
        let mut active = self
            .list(tasks)?
            .into_iter()
            .filter(|(record, linked_tasks)| is_auto_prune_candidate(record, linked_tasks))
            .map(|(record, _)| record)
            .collect::<Vec<_>>();
        active.sort_by_key(|record| std::cmp::Reverse(record.updated_at));
        let mut removed = Vec::new();
        for record in active.into_iter().skip(state.settings.keep_count) {
            if protected.contains(&normalized_path_key(Path::new(&record.path))) {
                continue;
            }
            removed.push(self.delete(Path::new(&record.path), true)?);
        }
        Ok(removed)
    }

    fn load(&self) -> WorktreeState {
        let mut state = fs::read_to_string(&self.state_path)
            .ok()
            .and_then(|content| serde_json::from_str::<WorktreeState>(&content).ok())
            .unwrap_or_default();
        state.version = STATE_VERSION;
        state.settings.resolved_worktree_root =
            resolve_worktree_root(&state.settings.worktree_root)
                .display()
                .to_string();
        let root = PathBuf::from(&state.settings.resolved_worktree_root);
        remember_root(&mut state.known_roots, &root);
        state
    }

    fn save(&self, state: &WorktreeState) -> Result<(), String> {
        if let Some(parent) = self.state_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }
        let payload = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
        let temporary = self
            .state_path
            .with_extension(format!("json.{}.tmp", std::process::id()));
        fs::write(&temporary, payload).map_err(|error| error.to_string())?;
        fs::rename(&temporary, &self.state_path).map_err(|error| error.to_string())
    }
}

struct Snapshot {
    reference: String,
    commit: String,
    git_common_dir: String,
}

fn snapshot_worktree(path: &Path, snapshot_dir: &Path) -> Result<Snapshot, String> {
    fs::create_dir_all(snapshot_dir).map_err(|error| error.to_string())?;
    let head = git_output(path, &["rev-parse", "HEAD"], None)?;
    let common_dir = git_output(
        path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        None,
    )?;
    let index = snapshot_dir.join(format!(
        "snapshot-index-{}-{}",
        std::process::id(),
        now_ms()
    ));
    let index_value = index.display().to_string();
    let envs = [("GIT_INDEX_FILE", index_value.as_str())];
    git_output(path, &["read-tree", &head], Some(&envs))?;
    git_output(path, &["add", "-A", "--", "."], Some(&envs))?;
    let tree = git_output(path, &["write-tree"], Some(&envs))?;
    let _ = fs::remove_file(&index);
    let commit_envs = [
        ("GIT_AUTHOR_NAME", "Wegent Worktree Snapshot"),
        ("GIT_AUTHOR_EMAIL", "snapshot@wegent.local"),
        ("GIT_COMMITTER_NAME", "Wegent Worktree Snapshot"),
        ("GIT_COMMITTER_EMAIL", "snapshot@wegent.local"),
    ];
    let commit = git_output(
        path,
        &[
            "commit-tree",
            &tree,
            "-p",
            &head,
            "-m",
            "Wegent worktree snapshot",
        ],
        Some(&commit_envs),
    )?;
    let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
    let digest = format!(
        "{:x}",
        Sha256::digest(canonical.to_string_lossy().as_bytes())
    );
    let reference = format!("refs/wegent/worktree-snapshots/{digest}");
    git_output(path, &["update-ref", &reference, &commit], None)?;
    Ok(Snapshot {
        reference,
        commit,
        git_common_dir: common_dir,
    })
}

fn add_git_worktree(source: &Path, target: &Path, git_ref: Option<&str>) -> Result<(), String> {
    let mut args = vec![
        "worktree",
        "add",
        "--detach",
        target.to_str().ok_or("Invalid target path")?,
    ];
    if let Some(git_ref) = git_ref.filter(|value| !value.trim().is_empty()) {
        args.push(git_ref);
    }
    git_output(source, &args, None).map(|_| ())
}

fn remove_git_worktree(path: &Path) -> Result<(), String> {
    let value = path.to_str().ok_or("Invalid worktree path")?;
    git_output(path, &["worktree", "remove", "--force", value], None).map(|_| ())
}

fn restore_git_worktree(git_common_dir: &Path, path: &Path, reference: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let output = Command::new("git")
        .arg("--git-dir")
        .arg(git_common_dir)
        .args(["worktree", "add", "--detach"])
        .arg(path)
        .arg(reference)
        .output()
        .map_err(|error| error.to_string())?;
    command_result(output).map(|_| ())
}

fn delete_snapshot_ref(git_common_dir: &Path, reference: &str) -> Result<(), String> {
    let output = Command::new("git")
        .arg("--git-dir")
        .arg(git_common_dir)
        .args(["update-ref", "-d", reference])
        .output()
        .map_err(|error| error.to_string())?;
    command_result(output).map(|_| ())
}

fn git_output(path: &Path, args: &[&str], envs: Option<&[(&str, &str)]>) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg("core.bare=false")
        .arg("-C")
        .arg(path)
        .args(args);
    command.env_remove("GIT_DIR").env_remove("GIT_WORK_TREE");
    if let Some(envs) = envs {
        command.envs(envs.iter().copied());
    }
    let output = command.output().map_err(|error| error.to_string())?;
    command_result(output)
}

fn command_result(output: std::process::Output) -> Result<String, String> {
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned());
    }
    Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
}

fn discover_worktrees(state: &mut WorktreeState) {
    let roots = state.known_roots.clone();
    for root in roots {
        let root = PathBuf::from(root);
        let Ok(ids) = fs::read_dir(&root) else {
            continue;
        };
        for id in ids.flatten().filter(|entry| entry.path().is_dir()) {
            let Ok(repositories) = fs::read_dir(id.path()) else {
                continue;
            };
            for repository in repositories.flatten().filter(|entry| entry.path().is_dir()) {
                let path = repository.path();
                if !path.join(".git").exists() {
                    continue;
                }
                let key = normalized_path_key(&path);
                state.records.entry(key).or_insert_with(|| ManagedWorktree {
                    worktree_id: id.file_name().to_string_lossy().to_string(),
                    path: path.display().to_string(),
                    repository_name: repository.file_name().to_string_lossy().to_string(),
                    ..ManagedWorktree::default()
                });
            }
        }
    }
    for record in state.records.values_mut() {
        if record.source_path.is_some() || !Path::new(&record.path).exists() {
            continue;
        }
        record.source_path = source_repository_path(Path::new(&record.path));
    }
}

fn source_repository_path(worktree_path: &Path) -> Option<String> {
    let common_dir = git_output(
        worktree_path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        None,
    )
    .ok()?;
    let common_dir = PathBuf::from(common_dir);
    if common_dir.file_name()?.to_str()? != ".git" {
        return None;
    }
    let repository = common_dir.parent()?;
    Some(
        fs::canonicalize(repository)
            .unwrap_or_else(|_| repository.to_path_buf())
            .display()
            .to_string(),
    )
}

fn normalize_configured_root(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(String::new());
    }
    let expanded = expand_home(value);
    if !expanded.is_absolute() {
        return Err("worktreeRoot must be an absolute path".to_owned());
    }
    ensure_safe_root(&expanded)?;
    Ok(expanded.display().to_string())
}

fn ensure_safe_root(root: &Path) -> Result<(), String> {
    if !root.is_absolute() || root.parent().is_none() {
        return Err("Worktree root must be an absolute non-root directory".to_owned());
    }
    Ok(())
}

fn ensure_managed_path(path: &Path, roots: &[String]) -> Result<(), String> {
    let normalized = normalized_path_key(path);
    let safe = roots.iter().any(|root| {
        let root = normalized_path_key(Path::new(root));
        normalized.starts_with(&format!("{root}/"))
            && normalized[root.len() + 1..].split('/').count() == 2
    });
    if !safe {
        return Err("Worktree path is outside managed roots".to_owned());
    }
    if path.exists() {
        let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
        let within_root = roots.iter().any(|root| {
            fs::canonicalize(root)
                .ok()
                .is_some_and(|root| canonical.starts_with(root))
        });
        let contains_symlink = path
            .parent()
            .and_then(|parent| parent.symlink_metadata().ok())
            .is_some_and(|metadata| metadata.file_type().is_symlink())
            || path
                .symlink_metadata()
                .ok()
                .is_some_and(|metadata| metadata.file_type().is_symlink());
        if !within_root || contains_symlink {
            return Err("Worktree path resolves outside managed roots".to_owned());
        }
    }
    Ok(())
}

fn canonical_existing_dir(path: &Path) -> Result<PathBuf, String> {
    let canonical =
        fs::canonicalize(path).map_err(|error| format!("Invalid source path: {error}"))?;
    if !canonical.is_dir() {
        return Err("Source path must be a directory".to_owned());
    }
    Ok(canonical)
}

fn validate_worktree_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err("worktreeId contains unsupported characters".to_owned());
    }
    Ok(())
}

fn remember_root(roots: &mut Vec<String>, root: &Path) {
    let value = normalized_path_key(root);
    if !roots
        .iter()
        .any(|item| normalized_path_key(Path::new(item)) == value)
    {
        roots.push(root.display().to_string());
    }
}

fn resolve_worktree_root(configured: &str) -> PathBuf {
    if !configured.trim().is_empty() {
        return expand_home(configured);
    }
    default_worktree_root()
}

fn default_worktree_root() -> PathBuf {
    default_worktree_root_from_paths(
        env::var_os("WEGENT_EXECUTOR_PROJECTS_DIR").map(PathBuf::from),
        env::var_os("WEGENT_EXECUTOR_HOME").map(PathBuf::from),
        env::var_os("WECODE_HOME").map(PathBuf::from),
        home_dir(),
    )
}

fn default_worktree_root_from_paths(
    projects: Option<PathBuf>,
    executor_home: Option<PathBuf>,
    wecode_home: Option<PathBuf>,
    home: PathBuf,
) -> PathBuf {
    if let Some(projects) = projects {
        if let Some(parent) = projects.parent() {
            return parent.join("worktrees");
        }
    }
    if let Some(executor_home) = executor_home {
        return executor_home.join("workspace").join("worktrees");
    }
    let base = wecode_home.unwrap_or_else(|| home.join(".wecode"));
    base.join("wegent-executor")
        .join("workspace")
        .join("worktrees")
}

fn expand_home(value: &str) -> PathBuf {
    if value == "~" {
        return home_dir();
    }
    value
        .strip_prefix("~/")
        .map(|rest| home_dir().join(rest))
        .unwrap_or_else(|| PathBuf::from(value))
}

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir)
}

fn normalized_path_key(path: &Path) -> String {
    path.to_string_lossy().trim_end_matches('/').to_owned()
}

fn same_path(left: &str, right: &str) -> bool {
    normalized_path_key(Path::new(left)) == normalized_path_key(Path::new(right))
}

fn is_auto_prune_candidate(record: &ManagedWorktree, linked_tasks: &[RuntimeTaskLink]) -> bool {
    record.state == "active"
        && !linked_tasks.is_empty()
        && linked_tasks.iter().all(|task| task.status == "archived")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use serde_json::Value;

    static TEST_DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn default_settings_match_codex() {
        let settings = WorktreeSettings::default();
        assert!(settings.auto_cleanup_enabled);
        assert_eq!(settings.keep_count, 15);
        assert!(settings.worktree_root.is_empty());
    }

    #[test]
    fn isolated_executor_home_owns_its_default_worktree_root() {
        let root = default_worktree_root_from_paths(
            None,
            Some(PathBuf::from("/tmp/isolated-executor")),
            Some(PathBuf::from("/tmp/shared-wecode")),
            PathBuf::from("/tmp/home"),
        );

        assert_eq!(
            root,
            PathBuf::from("/tmp/isolated-executor/workspace/worktrees")
        );
    }

    #[test]
    fn explicit_projects_directory_has_highest_worktree_root_precedence() {
        let root = default_worktree_root_from_paths(
            Some(PathBuf::from("/tmp/verification/workspace/projects")),
            Some(PathBuf::from("/tmp/isolated-executor")),
            Some(PathBuf::from("/tmp/shared-wecode")),
            PathBuf::from("/tmp/home"),
        );

        assert_eq!(root, PathBuf::from("/tmp/verification/workspace/worktrees"));
    }

    #[test]
    fn configured_root_must_be_absolute() {
        assert!(normalize_configured_root("relative/worktrees").is_err());
        assert!(normalize_configured_root("/").is_err());
        assert_eq!(normalize_configured_root("").unwrap(), "");
    }

    #[test]
    fn managed_path_requires_exact_worktree_depth() {
        let roots = vec!["/tmp/wegent-worktrees".to_owned()];
        assert!(ensure_managed_path(Path::new("/tmp/wegent-worktrees/id/repo"), &roots).is_ok());
        assert!(ensure_managed_path(Path::new("/tmp/wegent-worktrees/id"), &roots).is_err());
        assert!(ensure_managed_path(Path::new("/tmp/outside/id/repo"), &roots).is_err());
    }

    #[test]
    fn snapshot_delete_and_restore_preserve_uncommitted_files() {
        let root = test_directory("wegent-worktree-test");
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        run_git(&source, &["init"]);
        run_git(&source, &["config", "user.name", "Wegent Test"]);
        run_git(&source, &["config", "user.email", "test@wegent.local"]);
        fs::write(source.join("tracked.txt"), "base\n").unwrap();
        run_git(&source, &["add", "."]);
        run_git(&source, &["commit", "-m", "base"]);

        let manager = WorktreeManager::new(root.join("runtime-work/worktrees.json"));
        manager
            .update_settings(WorktreeSettingsPatch {
                worktree_root: Some(root.join("managed").display().to_string()),
                ..WorktreeSettingsPatch::default()
            })
            .unwrap();
        let record = manager.prepare(&source, "task-1", None).unwrap();
        let path = PathBuf::from(&record.path);
        fs::write(path.join("tracked.txt"), "changed\n").unwrap();
        fs::write(path.join("untracked.txt"), "new\n").unwrap();

        let deleted = manager.delete(&path, true).unwrap();
        assert_eq!(deleted.state, "restorable");
        assert!(!path.exists());

        manager.restore(&path).unwrap();
        assert_eq!(
            fs::read_to_string(path.join("tracked.txt")).unwrap(),
            "changed\n"
        );
        assert_eq!(
            fs::read_to_string(path.join("untracked.txt")).unwrap(),
            "new\n"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn auto_prune_only_selects_worktrees_linked_exclusively_to_archived_tasks() {
        let record = ManagedWorktree::default();
        let mut active_task = task_link("active");
        active_task.status = "active".to_owned();
        let mut archived_task = task_link("archived");
        archived_task.status = "archived".to_owned();

        assert!(!is_auto_prune_candidate(&record, &[active_task]));
        assert!(is_auto_prune_candidate(&record, &[archived_task]));
        assert!(!is_auto_prune_candidate(&record, &[]));
    }

    #[test]
    fn discovered_worktree_includes_source_repository_path() {
        let root = test_directory("wegent-worktree-discovery-test");
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        run_git(&source, &["init"]);
        run_git(&source, &["config", "user.name", "Wegent Test"]);
        run_git(&source, &["config", "user.email", "test@wegent.local"]);
        fs::write(source.join("tracked.txt"), "base\n").unwrap();
        run_git(&source, &["add", "."]);
        run_git(&source, &["commit", "-m", "base"]);

        let manager = WorktreeManager::new(root.join("runtime-work/worktrees.json"));
        let managed_root = root.join("managed");
        fs::create_dir_all(&managed_root).unwrap();
        manager
            .save(&WorktreeState {
                version: STATE_VERSION,
                settings: WorktreeSettings {
                    worktree_root: managed_root.display().to_string(),
                    resolved_worktree_root: managed_root.display().to_string(),
                    ..WorktreeSettings::default()
                },
                known_roots: vec![managed_root.display().to_string()],
                records: HashMap::new(),
            })
            .unwrap();
        let managed = managed_root.join("task-1/source");
        run_git(
            &source,
            &[
                "worktree",
                "add",
                "-b",
                "discovery-test",
                managed.to_str().unwrap(),
            ],
        );

        let discovered = manager.list(&[]).unwrap();
        assert_eq!(discovered.len(), 1);
        assert_eq!(
            discovered[0].0.source_path.as_deref(),
            Some(fs::canonicalize(&source).unwrap().to_str().unwrap())
        );
        let _ = fs::remove_dir_all(root);
    }

    fn test_directory(prefix: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            TEST_DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn run_git(path: &Path, args: &[&str]) {
        let mut command = Command::new("git");
        command
            .arg("-c")
            .arg("core.bare=false")
            .arg("-C")
            .arg(path)
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE");
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "git -C {} {} failed: {}",
            path.display(),
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn task_link(id: &str) -> RuntimeTaskLink {
        RuntimeTaskLink {
            local_task_id: id.to_owned(),
            thread_id: None,
            workspace_path: format!("/tmp/{id}"),
            title: id.to_owned(),
            runtime: "codex".to_owned(),
            status: "active".to_owned(),
            running: false,
            goal_status: None,
            git_info: None,
            created_at: 0,
            updated_at: 0,
            runtime_handle: Value::Null,
            parent: None,
            ephemeral: false,
            list_order: None,
            group_workspace_path: None,
            group_project_key: None,
            pinned: false,
            pinned_order: None,
        }
    }
}
