// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{HashMap, HashSet},
    env, fs,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::config::device::worktree_persistent_storage_verified;

use super::{response::RuntimeTaskLink, store::runtime_work_dir};

const STATE_VERSION: u64 = 5;
const DEFAULT_KEEP_COUNT: usize = 15;
const AUTO_PRUNE_BATCH_SIZE: usize = 1;
pub(crate) const RUNTIME_WORKTREES_VERSION: u64 = 1;
static WORKTREE_WRITE_PROBE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const STATE_ACTIVE: &str = "active";
const STATE_DELETED: &str = "deleted";
const STATE_FAILED: &str = "failed";
const STATE_MISSING: &str = "missing";
const STATE_PREPARING: &str = "preparing";
const STATE_RESTORABLE: &str = "restorable";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeCapabilities {
    pub version: u64,
    pub managed: bool,
    pub deferred_prepare: bool,
    pub snapshots: bool,
    pub restore: bool,
    pub preflight: bool,
    pub reconcile: bool,
    pub persistent_storage_verified: bool,
}

impl Default for WorktreeCapabilities {
    fn default() -> Self {
        Self {
            version: RUNTIME_WORKTREES_VERSION,
            managed: true,
            deferred_prepare: true,
            snapshots: true,
            restore: true,
            preflight: true,
            reconcile: true,
            persistent_storage_verified: true,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreePreflight {
    pub supported: bool,
    pub source_path: String,
    pub source_exists: bool,
    pub source_directory: bool,
    pub git_repository: bool,
    pub git_common_dir_valid: bool,
    pub git_common_dir_writable: bool,
    pub repo_root: Option<String>,
    pub git_common_dir: Option<String>,
    pub repo_root_fingerprint: Option<String>,
    pub git_ref: Option<String>,
    pub ref_valid: Option<bool>,
    pub writable: bool,
    pub resolved_worktree_root: String,
    pub error_code: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct WorktreePlan {
    pub source_path: PathBuf,
    pub path: PathBuf,
    pub repo_root_fingerprint: String,
}

#[derive(Clone, Debug)]
pub(crate) struct WorktreeReconciliation {
    pub record: ManagedWorktree,
    pub interrupted_preparation: bool,
    pub interrupted_execution: bool,
    pub interrupted_execution_task_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeExecutionLease {
    #[serde(default)]
    pub task_id: String,
    pub execution_id: u64,
    pub started_at: i64,
    #[serde(default)]
    pub owner_id: String,
}

#[derive(Clone, Debug)]
struct RepositoryInfo {
    source_path: PathBuf,
    repo_root: PathBuf,
    git_common_dir: PathBuf,
    repo_root_fingerprint: String,
}

#[derive(Default)]
pub(crate) struct WorktreePruneBatch {
    pub removed: Vec<ManagedWorktree>,
    pub errors: Vec<String>,
}

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
    pub device_id: String,
    pub path: String,
    pub repository_name: String,
    pub source_path: Option<String>,
    pub permanent: bool,
    pub preparation_owned_path: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub snapshot_ref: Option<String>,
    pub snapshot_commit: Option<String>,
    pub snapshot_at: Option<i64>,
    pub git_common_dir: Option<String>,
    pub state: String,
    pub last_error: Option<String>,
    pub execution_lease: Option<WorktreeExecutionLease>,
}

impl Default for ManagedWorktree {
    fn default() -> Self {
        let now = now_ms();
        Self {
            worktree_id: String::new(),
            device_id: String::new(),
            path: String::new(),
            repository_name: String::new(),
            source_path: None,
            permanent: false,
            preparation_owned_path: false,
            created_at: now,
            updated_at: now,
            snapshot_ref: None,
            snapshot_commit: None,
            snapshot_at: None,
            git_common_dir: None,
            state: STATE_ACTIVE.to_owned(),
            last_error: None,
            execution_lease: None,
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
    device_id: String,
    execution_owner_id: String,
    persistent_storage_verified: bool,
    mutation_lock: Arc<Mutex<()>>,
}

impl WorktreeManager {
    pub fn source_path_for(&self, workspace_path: &str) -> Option<String> {
        let normalized_path = normalized_path_key(Path::new(workspace_path));
        self.load()
            .records
            .get(&normalized_path)
            .and_then(|record| record.source_path.clone())
    }

    fn busy_task_repositories(&self, tasks: &[RuntimeTaskLink]) -> HashSet<String> {
        tasks
            .iter()
            .filter(|task| task.running)
            .flat_map(|task| {
                [
                    Some(normalized_path_key(Path::new(&task.workspace_path))),
                    self.source_path_for(&task.workspace_path)
                        .map(|path| normalized_path_key(Path::new(&path))),
                ]
            })
            .flatten()
            .collect()
    }

    pub fn from_env(device_id: &str) -> Self {
        Self::new_for_device_with_storage(
            runtime_work_dir().join("worktrees.json"),
            device_id,
            worktree_persistent_storage_verified(),
        )
    }

    #[cfg(test)]
    pub(crate) fn new(state_path: PathBuf) -> Self {
        let device_id = env::var("DEVICE_ID").unwrap_or_else(|_| "local-device".to_owned());
        Self::new_for_device(state_path, &device_id)
    }

    #[cfg(test)]
    pub(crate) fn new_for_device(state_path: PathBuf, device_id: &str) -> Self {
        Self::new_for_device_with_storage(state_path, device_id, true)
    }

    #[cfg_attr(test, allow(dead_code))]
    pub(crate) fn new_for_device_with_storage(
        state_path: PathBuf,
        device_id: &str,
        persistent_storage_verified: bool,
    ) -> Self {
        Self {
            state_path,
            device_id: normalize_device_id(device_id),
            execution_owner_id: Uuid::new_v4().to_string(),
            persistent_storage_verified,
            mutation_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn settings(&self) -> WorktreeSettings {
        self.load().settings
    }

    pub fn capabilities(&self) -> WorktreeCapabilities {
        WorktreeCapabilities {
            persistent_storage_verified: self.persistent_storage_verified,
            ..WorktreeCapabilities::default()
        }
    }

    pub fn capabilities_from_env() -> WorktreeCapabilities {
        WorktreeCapabilities {
            persistent_storage_verified: worktree_persistent_storage_verified(),
            ..WorktreeCapabilities::default()
        }
    }

    pub fn preflight(&self, source_path: &Path, git_ref: Option<&str>) -> WorktreePreflight {
        let state = self.load();
        if !self.persistent_storage_verified {
            return persistent_storage_unverified_preflight(
                source_path,
                git_ref,
                Path::new(&state.settings.resolved_worktree_root),
            );
        }
        worktree_preflight(
            source_path,
            git_ref,
            Path::new(&state.settings.resolved_worktree_root),
        )
    }

    pub fn plan(
        &self,
        source_path: &Path,
        worktree_id: &str,
        git_ref: Option<&str>,
    ) -> Result<WorktreePlan, String> {
        self.ensure_persistent_storage_verified()?;
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| "Worktree mutation lock is unavailable".to_owned())?;
        validate_worktree_id(worktree_id)?;
        let state = self.load();
        let root = PathBuf::from(&state.settings.resolved_worktree_root);
        let preflight = worktree_preflight(source_path, git_ref, &root);
        let repository = validated_repository_from_preflight(&preflight)?;
        let repository_name = repository
            .repo_root
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("repository");
        ensure_safe_root(&root)?;
        let path = root.join(worktree_id).join(repository_name);
        ensure_managed_path(&path, &state.known_roots)?;
        Ok(WorktreePlan {
            source_path: repository.repo_root,
            path,
            repo_root_fingerprint: repository.repo_root_fingerprint,
        })
    }

    pub fn is_managed_path(&self, path: &Path) -> bool {
        ensure_managed_path(path, &self.load().known_roots).is_ok()
    }

    pub fn begin_execution(
        &self,
        path: &Path,
        task_id: &str,
        execution_id: u64,
    ) -> Result<(), String> {
        self.update_execution_lease(
            path,
            Some(WorktreeExecutionLease {
                task_id: task_id.to_owned(),
                execution_id,
                started_at: now_ms(),
                owner_id: self.execution_owner_id.clone(),
            }),
            None,
        )
        .map(|_| ())
    }

    pub fn finish_execution(
        &self,
        path: &Path,
        task_id: &str,
        execution_id: u64,
    ) -> Result<bool, String> {
        self.update_execution_lease(path, None, Some((task_id, execution_id)))
    }

    fn update_execution_lease(
        &self,
        path: &Path,
        execution_lease: Option<WorktreeExecutionLease>,
        expected_execution: Option<(&str, u64)>,
    ) -> Result<bool, String> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| "Worktree execution lock is unavailable".to_owned())?;
        let mut state = self.load();
        let key = normalized_path_key(path);
        let record = state
            .records
            .get_mut(&key)
            .ok_or_else(|| "Managed worktree was not found".to_owned())?;
        if let Some((task_id, execution_id)) = expected_execution {
            match record.execution_lease.as_ref() {
                Some(lease) if lease.execution_id == execution_id && lease.task_id == task_id => {}
                None if execution_lease.is_none() => return Ok(true),
                _ => return Ok(false),
            }
        } else if let Some(lease) = record.execution_lease.as_ref() {
            return Err(format!(
                "Managed worktree {} is already executing task {}",
                path.display(),
                lease.task_id
            ));
        }
        record.execution_lease = execution_lease;
        self.save(&state)?;
        Ok(true)
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
        permanent: bool,
    ) -> Result<ManagedWorktree, String> {
        self.prepare_with_path(source_path, worktree_id, git_ref, permanent, None, None)
    }

    pub fn prepare_at(
        &self,
        source_path: &Path,
        worktree_id: &str,
        git_ref: Option<&str>,
        permanent: bool,
        planned_path: &Path,
    ) -> Result<ManagedWorktree, String> {
        self.prepare_with_path(
            source_path,
            worktree_id,
            git_ref,
            permanent,
            Some(planned_path),
            None,
        )
    }

    pub fn prepare_planned(
        &self,
        source_path: &Path,
        worktree_id: &str,
        git_ref: Option<&str>,
        permanent: bool,
        planned_path: &Path,
        repo_root_fingerprint: &str,
    ) -> Result<ManagedWorktree, String> {
        self.prepare_with_path(
            source_path,
            worktree_id,
            git_ref,
            permanent,
            Some(planned_path),
            Some(repo_root_fingerprint),
        )
    }

    fn prepare_with_path(
        &self,
        source_path: &Path,
        worktree_id: &str,
        git_ref: Option<&str>,
        permanent: bool,
        planned_path: Option<&Path>,
        expected_repo_root_fingerprint: Option<&str>,
    ) -> Result<ManagedWorktree, String> {
        self.ensure_persistent_storage_verified()?;
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| "Worktree mutation lock is unavailable".to_owned())?;
        validate_worktree_id(worktree_id)?;
        let mut state = self.load();
        let root = match planned_path {
            Some(path) => path
                .parent()
                .and_then(Path::parent)
                .map(Path::to_path_buf)
                .ok_or_else(|| format!("Invalid planned worktree path {}", path.display()))?,
            None => PathBuf::from(&state.settings.resolved_worktree_root),
        };
        let preflight = worktree_preflight(source_path, git_ref, &root);
        let repository = validated_repository_from_preflight(&preflight)?;
        if expected_repo_root_fingerprint
            .is_some_and(|expected| expected != repository.repo_root_fingerprint)
        {
            return Err(
                "worktree_source_changed: Source repository identity changed after planning"
                    .to_owned(),
            );
        }
        let source_path = repository.repo_root;
        let repository_name = source_path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("repository")
            .to_owned();
        ensure_safe_root(&root)?;
        let expected_path = root.join(worktree_id).join(&repository_name);
        let path = planned_path.unwrap_or(&expected_path);
        if path != expected_path {
            return Err(worktree_target_conflict(format!(
                "Planned worktree path {} does not match task {worktree_id}",
                path.display()
            )));
        }
        ensure_managed_path(path, &state.known_roots)?;
        let path_preexisted = path.exists();
        let key = normalized_path_key(path);
        let now = now_ms();
        let mut record = state.records.remove(&key).unwrap_or_default();
        validate_existing_record_identity(&record, path, worktree_id, &repository.git_common_dir)?;
        record.worktree_id = worktree_id.to_owned();
        record.device_id = self.device_id.clone();
        record.path = path.display().to_string();
        record.repository_name = repository_name;
        record.source_path = Some(source_path.display().to_string());
        record.git_common_dir = Some(repository.git_common_dir.display().to_string());
        record.permanent = permanent;
        record.preparation_owned_path = !path_preexisted;
        record.updated_at = now;
        record.state = STATE_PREPARING.to_owned();
        record.last_error = None;
        state.records.insert(key.clone(), record.clone());
        remember_root(&mut state.known_roots, &root);
        self.save(&state)?;

        let prepared = (|| {
            fs::create_dir_all(&root)
                .map_err(|error| format!("Failed to create {}: {error}", root.display()))?;
            if path.exists() {
                validate_existing_worktree_identity(
                    &source_path,
                    path,
                    worktree_id,
                    &repository.git_common_dir,
                )?;
            } else {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|error| {
                        format!("Failed to create {}: {error}", parent.display())
                    })?;
                }
                add_git_worktree(&source_path, path, git_ref)?;
                validate_existing_worktree_identity(
                    &source_path,
                    path,
                    worktree_id,
                    &repository.git_common_dir,
                )?;
            }
            Ok::<(), String>(())
        })();

        match prepared {
            Ok(()) => {
                record.state = STATE_ACTIVE.to_owned();
                record.preparation_owned_path = false;
                record.updated_at = now_ms();
                record.last_error = None;
                state.records.insert(key, record.clone());
                self.save(&state)?;
                Ok(record)
            }
            Err(error) => {
                record.state = STATE_FAILED.to_owned();
                record.updated_at = now_ms();
                record.last_error = Some(error.clone());
                state.records.insert(key, record);
                if let Err(save_error) = self.save(&state) {
                    return Err(format!(
                        "{error}; additionally failed to persist worktree failure: {save_error}"
                    ));
                }
                Err(error)
            }
        }
    }

    fn ensure_persistent_storage_verified(&self) -> Result<(), String> {
        if self.persistent_storage_verified {
            return Ok(());
        }
        Err(
            "worktree_persistent_storage_unverified: Persistent Worktree storage is not verified"
                .to_owned(),
        )
    }

    pub fn list(
        &self,
        tasks: &[RuntimeTaskLink],
    ) -> Result<Vec<(ManagedWorktree, Vec<RuntimeTaskLink>)>, String> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| "Worktree mutation lock is unavailable".to_owned())?;
        let mut state = self.load();
        discover_worktrees(&mut state, &self.device_id);
        reconcile_worktree_state(&mut state, &self.execution_owner_id, false)?;
        let mut result = state
            .records
            .values_mut()
            .map(|record| {
                record.state = if matches!(
                    record.state.as_str(),
                    STATE_FAILED | STATE_PREPARING | STATE_DELETED
                ) {
                    record.state.clone()
                } else {
                    if Path::new(&record.path).exists() {
                        STATE_ACTIVE
                    } else if record.snapshot_ref.is_some() && record.git_common_dir.is_some() {
                        STATE_RESTORABLE
                    } else {
                        STATE_MISSING
                    }
                    .to_owned()
                };
                let linked = tasks
                    .iter()
                    .filter(|task| same_path(&task.workspace_path, &record.path))
                    .cloned()
                    .collect::<Vec<_>>();
                (record.clone(), linked)
            })
            .collect::<Vec<_>>();
        result.sort_by_key(|(record, _)| std::cmp::Reverse(record.updated_at));
        self.save(&state)?;
        Ok(result)
    }

    pub fn reconcile(&self) -> Result<Vec<WorktreeReconciliation>, String> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| "Worktree mutation lock is unavailable".to_owned())?;
        let mut state = self.load();
        discover_worktrees(&mut state, &self.device_id);
        let reconciled = reconcile_worktree_state(&mut state, &self.execution_owner_id, true)?;
        self.save(&state)?;
        Ok(reconciled)
    }

    pub fn delete(&self, path: &Path, preserve_snapshot: bool) -> Result<ManagedWorktree, String> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| "Worktree mutation lock is unavailable".to_owned())?;
        let mut state = self.load();
        discover_worktrees(&mut state, &self.device_id);
        ensure_managed_path(path, &state.known_roots)?;
        let key = normalized_path_key(path);
        let mut record = state
            .records
            .remove(&key)
            .ok_or_else(|| "Managed worktree was not found".to_owned())?;
        if path.exists() {
            validate_record_worktree_identity(&record, path)?;
        }
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
        if !preserve_snapshot {
            if let (Some(git_common_dir), Some(reference)) = (
                record.git_common_dir.as_deref(),
                record.snapshot_ref.as_deref(),
            ) {
                delete_snapshot_ref(Path::new(git_common_dir), reference)?;
            }
            record.snapshot_ref = None;
            record.snapshot_commit = None;
            record.snapshot_at = None;
        }
        record.state = if preserve_snapshot && record.snapshot_ref.is_some() {
            STATE_RESTORABLE
        } else {
            STATE_DELETED
        }
        .to_owned();
        record.updated_at = now_ms();
        record.last_error = None;
        if preserve_snapshot {
            state.records.insert(key, record.clone());
        }
        self.save(&state)?;
        remove_empty_worktree_container(path)?;
        Ok(record)
    }

    pub fn discard_failed_preparation(
        &self,
        path: &Path,
        worktree_id: &str,
    ) -> Result<Option<ManagedWorktree>, String> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| "Worktree mutation lock is unavailable".to_owned())?;
        let mut state = self.load();
        ensure_managed_path(path, &state.known_roots)?;
        let key = normalized_path_key(path);
        let Some(mut record) = state.records.remove(&key) else {
            if path.exists() {
                return Err(worktree_target_conflict(format!(
                    "Untracked failed preparation target {} was preserved",
                    path.display()
                )));
            }
            return Ok(None);
        };
        if record.worktree_id != worktree_id {
            state.records.insert(key, record);
            return Err(worktree_target_conflict(format!(
                "Worktree {} belongs to another task",
                path.display()
            )));
        }
        if !matches!(record.state.as_str(), STATE_PREPARING | STATE_FAILED) {
            state.records.insert(key, record);
            return Err(worktree_target_conflict(format!(
                "Worktree {} is not a failed preparation",
                path.display()
            )));
        }
        if path.exists() && !record.preparation_owned_path {
            state.records.insert(key, record);
            return Err(worktree_target_conflict(format!(
                "Pre-existing target {} was preserved",
                path.display()
            )));
        }
        if path.exists() {
            if validate_record_worktree_identity(&record, path).is_ok() {
                remove_git_worktree(path)?;
            } else {
                fs::remove_dir_all(path).map_err(|error| {
                    format!(
                        "Failed to remove interrupted Worktree preparation {}: {error}",
                        path.display()
                    )
                })?;
                if let Some(source_path) = record.source_path.as_deref() {
                    let _ = git_output(Path::new(source_path), &["worktree", "prune"], None);
                }
            }
        }
        record.state = STATE_DELETED.to_owned();
        record.preparation_owned_path = false;
        record.updated_at = now_ms();
        record.last_error = None;
        state.records.insert(key, record.clone());
        self.save(&state)?;
        remove_empty_worktree_container(path)?;
        Ok(Some(record))
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
            validate_record_worktree_identity(&record, path)?;
            record.state = STATE_ACTIVE.to_owned();
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
            validate_record_worktree_identity(&record, path)?;
            record.state = STATE_ACTIVE.to_owned();
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
        self.prune_up_to(tasks, usize::MAX)
    }

    pub fn prune_auto_batch(
        &self,
        tasks: &[RuntimeTaskLink],
    ) -> Result<WorktreePruneBatch, String> {
        let state = self.load();
        if !state.settings.auto_cleanup_enabled {
            return Ok(WorktreePruneBatch::default());
        }
        let listed = self.list(tasks)?;
        let busy_task_repositories = self.busy_task_repositories(tasks);
        let candidates = select_auto_prune_candidates(
            listed,
            tasks,
            &busy_task_repositories,
            state.settings.keep_count,
            usize::MAX,
        );
        Ok(remove_auto_prune_candidates(
            candidates,
            AUTO_PRUNE_BATCH_SIZE,
            |record| self.delete(Path::new(&record.path), true),
        ))
    }

    fn prune_up_to(
        &self,
        tasks: &[RuntimeTaskLink],
        max_removals: usize,
    ) -> Result<Vec<ManagedWorktree>, String> {
        let state = self.load();
        if !state.settings.auto_cleanup_enabled {
            return Ok(Vec::new());
        }
        let listed = self.list(tasks)?;
        let busy_task_repositories = self.busy_task_repositories(tasks);
        let mut removed = Vec::new();
        for record in select_auto_prune_candidates(
            listed,
            tasks,
            &busy_task_repositories,
            state.settings.keep_count,
            max_removals,
        ) {
            removed.push(self.delete(Path::new(&record.path), true)?);
        }
        Ok(removed)
    }

    fn load(&self) -> WorktreeState {
        let mut state = fs::read_to_string(&self.state_path)
            .ok()
            .and_then(|content| serde_json::from_str::<WorktreeState>(&content).ok())
            .unwrap_or_else(|| initial_worktree_state(&self.state_path));
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
        let temporary =
            self.state_path
                .with_extension(format!("json.{}.{}.tmp", std::process::id(), now_ms()));
        let result = (|| {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .map_err(|error| error.to_string())?;
            file.write_all(&payload)
                .and_then(|_| file.sync_all())
                .map_err(|error| error.to_string())?;
            fs::rename(&temporary, &self.state_path).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            if let Some(parent) = self.state_path.parent() {
                fs::File::open(parent)
                    .and_then(|directory| directory.sync_all())
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

#[cfg(not(test))]
fn initial_worktree_state(_state_path: &Path) -> WorktreeState {
    WorktreeState::default()
}

#[cfg(test)]
fn initial_worktree_state(state_path: &Path) -> WorktreeState {
    let mut state = WorktreeState::default();
    let root = state_path
        .parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("."))
        .join("workspace/worktrees");
    state.settings.worktree_root = root.display().to_string();
    state.settings.resolved_worktree_root = root.display().to_string();
    state
}

struct Snapshot {
    reference: String,
    commit: String,
    git_common_dir: String,
}

fn snapshot_worktree(path: &Path, snapshot_dir: &Path) -> Result<Snapshot, String> {
    fs::create_dir_all(snapshot_dir).map_err(|error| error.to_string())?;
    let head = git_output(path, &["rev-parse", "HEAD"], None)?;
    let common_dir = git_common_dir(path)?;
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
        git_common_dir: common_dir.display().to_string(),
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

fn remove_empty_worktree_container(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    remove_empty_directory(parent)
}

fn remove_empty_directory(path: &Path) -> Result<(), String> {
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(format!(
            "Failed to remove empty worktree directory {}: {error}",
            path.display()
        )),
    }
}

fn restore_git_worktree(git_common_dir: &Path, path: &Path, reference: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut command = Command::new("git");
    command
        .arg("--git-dir")
        .arg(git_common_dir)
        .args(["worktree", "add", "--detach"])
        .arg(path)
        .arg(reference);
    crate::process::hide_windows_console(&mut command);
    let output = command.output().map_err(|error| error.to_string())?;
    command_result(output).map(|_| ())
}

fn delete_snapshot_ref(git_common_dir: &Path, reference: &str) -> Result<(), String> {
    let mut command = Command::new("git");
    command
        .arg("--git-dir")
        .arg(git_common_dir)
        .args(["update-ref", "-d", reference]);
    crate::process::hide_windows_console(&mut command);
    let output = command.output().map_err(|error| error.to_string())?;
    command_result(output).map(|_| ())
}

fn git_output(path: &Path, args: &[&str], envs: Option<&[(&str, &str)]>) -> Result<String, String> {
    let mut command = Command::new("git");
    crate::process::hide_windows_console(&mut command);
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

#[derive(Clone, Debug)]
struct WorktreeValidationFailure {
    code: &'static str,
    message: String,
}

impl WorktreeValidationFailure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

fn worktree_preflight(
    source_path: &Path,
    git_ref: Option<&str>,
    worktree_root: &Path,
) -> WorktreePreflight {
    let git_ref = git_ref
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let source_metadata = fs::metadata(source_path);
    let source_exists = source_metadata.is_ok();
    let source_directory = source_metadata
        .as_ref()
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false);
    let root_writable = probe_directory_writable(worktree_root)
        .map_err(|error| WorktreeValidationFailure::new("worktree_root_unwritable", error));
    let mut response = WorktreePreflight {
        supported: true,
        source_path: source_path.display().to_string(),
        source_exists,
        source_directory,
        git_repository: false,
        git_common_dir_valid: false,
        git_common_dir_writable: false,
        repo_root: None,
        git_common_dir: None,
        repo_root_fingerprint: None,
        git_ref: git_ref.clone(),
        ref_valid: git_ref.as_ref().map(|_| false),
        writable: false,
        resolved_worktree_root: worktree_root.display().to_string(),
        error_code: None,
        error: None,
    };

    let repository = repository_info(source_path).map_err(|error| {
        if !source_exists {
            WorktreeValidationFailure::new(
                "worktree_source_missing",
                format!("Source path {} does not exist", source_path.display()),
            )
        } else if !source_directory {
            WorktreeValidationFailure::new(
                "worktree_source_missing",
                format!("Source path {} is not a directory", source_path.display()),
            )
        } else {
            error
        }
    });

    let mut validation_error = None;
    match repository {
        Ok(repository) => {
            response.source_path = repository.source_path.display().to_string();
            response.git_repository = true;
            response.git_common_dir_valid = true;
            response.repo_root = Some(repository.repo_root.display().to_string());
            response.git_common_dir = Some(repository.git_common_dir.display().to_string());
            response.repo_root_fingerprint = Some(repository.repo_root_fingerprint);

            let common_dir_writable =
                probe_directory_writable(&repository.git_common_dir).map_err(|error| {
                    WorktreeValidationFailure::new(
                        "worktree_git_common_dir_unwritable",
                        format!(
                            "Git common directory {} is not writable: {error}",
                            repository.git_common_dir.display()
                        ),
                    )
                });
            response.git_common_dir_writable = common_dir_writable.is_ok();
            if let Err(error) = common_dir_writable {
                validation_error = Some(error);
            }

            if let Some(git_ref) = git_ref.as_deref() {
                match git_ref_exists(&repository.repo_root, git_ref) {
                    Ok(true) => response.ref_valid = Some(true),
                    Ok(false) => {
                        validation_error.get_or_insert_with(|| {
                            WorktreeValidationFailure::new(
                                "worktree_ref_not_found",
                                format!("Git ref {git_ref} was not found"),
                            )
                        });
                    }
                    Err(error) => {
                        validation_error.get_or_insert_with(|| {
                            WorktreeValidationFailure::new("worktree_ref_not_found", error)
                        });
                    }
                }
            }
        }
        Err(error) => validation_error = Some(error),
    }

    if let Err(error) = root_writable.as_ref() {
        validation_error.get_or_insert_with(|| error.clone());
    }
    response.writable =
        root_writable.is_ok() && response.git_common_dir_writable && validation_error.is_none();
    if let Some(error) = validation_error {
        response.error_code = Some(error.code.to_owned());
        response.error = Some(error.message);
    }
    response
}

fn persistent_storage_unverified_preflight(
    source_path: &Path,
    git_ref: Option<&str>,
    worktree_root: &Path,
) -> WorktreePreflight {
    let source_metadata = fs::metadata(source_path);
    WorktreePreflight {
        supported: false,
        source_path: source_path.display().to_string(),
        source_exists: source_metadata.is_ok(),
        source_directory: source_metadata
            .as_ref()
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false),
        git_repository: false,
        git_common_dir_valid: false,
        git_common_dir_writable: false,
        repo_root: None,
        git_common_dir: None,
        repo_root_fingerprint: None,
        git_ref: git_ref
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        ref_valid: None,
        writable: false,
        resolved_worktree_root: worktree_root.display().to_string(),
        error_code: Some("worktree_persistent_storage_unverified".to_owned()),
        error: Some("Persistent Worktree storage is not verified".to_owned()),
    }
}

fn validated_repository_from_preflight(
    preflight: &WorktreePreflight,
) -> Result<RepositoryInfo, String> {
    if let Some(code) = preflight.error_code.as_deref() {
        return Err(format!(
            "{code}: {}",
            preflight
                .error
                .as_deref()
                .unwrap_or("Worktree preflight failed")
        ));
    }
    let repo_root = preflight
        .repo_root
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| "worktree_source_not_git: Repository root is unavailable".to_owned())?;
    let git_common_dir = preflight
        .git_common_dir
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| "worktree_source_not_git: Git common directory is unavailable".to_owned())?;
    let repo_root_fingerprint = preflight.repo_root_fingerprint.clone().ok_or_else(|| {
        "worktree_source_not_git: Repository fingerprint is unavailable".to_owned()
    })?;
    Ok(RepositoryInfo {
        source_path: PathBuf::from(&preflight.source_path),
        repo_root,
        git_common_dir,
        repo_root_fingerprint,
    })
}

fn repository_fingerprint(git_common_dir: &Path) -> Result<String, WorktreeValidationFailure> {
    let metadata = fs::metadata(git_common_dir).map_err(|error| {
        WorktreeValidationFailure::new(
            "worktree_source_not_git",
            format!(
                "Failed to read Git common directory identity {}: {error}",
                git_common_dir.display()
            ),
        )
    })?;
    let mut hasher = Sha256::new();
    hasher.update(normalized_path_key(git_common_dir).as_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        hasher.update(metadata.dev().to_le_bytes());
        hasher.update(metadata.ino().to_le_bytes());
    }
    #[cfg(not(unix))]
    {
        let created = metadata
            .created()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        hasher.update(created.to_le_bytes());
        hasher.update(metadata.len().to_le_bytes());
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn repository_info(source_path: &Path) -> Result<RepositoryInfo, WorktreeValidationFailure> {
    let source_path = canonical_existing_dir(source_path)
        .map_err(|error| WorktreeValidationFailure::new("worktree_source_missing", error))?;
    let inside_work_tree = git_output(&source_path, &["rev-parse", "--is-inside-work-tree"], None)
        .map_err(|error| {
            WorktreeValidationFailure::new(
                "worktree_source_not_git",
                format!("Source path is not a Git working tree: {error}"),
            )
        })?;
    if inside_work_tree != "true" {
        return Err(WorktreeValidationFailure::new(
            "worktree_source_not_git",
            "Source path is not inside a Git working tree",
        ));
    }
    let repo_root = PathBuf::from(
        git_output(&source_path, &["rev-parse", "--show-toplevel"], None).map_err(|error| {
            WorktreeValidationFailure::new(
                "worktree_source_not_git",
                format!("Failed to resolve Git repository root: {error}"),
            )
        })?,
    );
    let repo_root = fs::canonicalize(&repo_root).map_err(|error| {
        WorktreeValidationFailure::new(
            "worktree_source_not_git",
            format!("Failed to canonicalize {}: {error}", repo_root.display()),
        )
    })?;
    if source_path != repo_root && !source_path.starts_with(&repo_root) {
        return Err(WorktreeValidationFailure::new(
            "worktree_source_changed",
            format!(
                "Source path {} is outside repository root {}",
                source_path.display(),
                repo_root.display()
            ),
        ));
    }
    let git_common_dir = git_common_dir(&repo_root).map_err(|error| {
        WorktreeValidationFailure::new(
            "worktree_source_not_git",
            format!("Failed to resolve Git common directory: {error}"),
        )
    })?;
    if !git_common_dir.is_dir() {
        return Err(WorktreeValidationFailure::new(
            "worktree_source_not_git",
            format!(
                "Git common directory {} is unavailable",
                git_common_dir.display()
            ),
        ));
    }
    let repo_root_fingerprint = repository_fingerprint(&git_common_dir)?;
    Ok(RepositoryInfo {
        source_path,
        repo_root,
        git_common_dir,
        repo_root_fingerprint,
    })
}

fn git_ref_exists(repo_root: &Path, git_ref: &str) -> Result<bool, String> {
    if git_ref.starts_with('-') || git_ref.chars().any(char::is_control) {
        return Ok(false);
    }
    let commit = format!("{git_ref}^{{commit}}");
    let mut command = Command::new("git");
    crate::process::hide_windows_console(&mut command);
    command
        .arg("-c")
        .arg("core.bare=false")
        .arg("-C")
        .arg(repo_root)
        .args(["rev-parse", "--verify", "--quiet", "--end-of-options"])
        .arg(commit)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE");
    let output = command.output().map_err(|error| error.to_string())?;
    Ok(output.status.success())
}

fn probe_directory_writable(path: &Path) -> Result<(), String> {
    ensure_safe_root(path)?;
    let probe_parent = if path.exists() {
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!("{} is not a regular directory", path.display()));
        }
        path.to_path_buf()
    } else {
        let mut ancestor = path.parent();
        loop {
            let Some(candidate) = ancestor else {
                return Err(format!(
                    "No existing parent is available for {}",
                    path.display()
                ));
            };
            if candidate.exists() {
                let metadata =
                    fs::symlink_metadata(candidate).map_err(|error| error.to_string())?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!(
                        "{} is not a regular directory",
                        candidate.display()
                    ));
                }
                break candidate.to_path_buf();
            }
            ancestor = candidate.parent();
        }
    };
    let probe_sequence = WORKTREE_WRITE_PROBE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let probe = probe_parent.join(format!(
        ".wegent-worktree-write-probe-{}-{}-{probe_sequence}",
        std::process::id(),
        now_ms()
    ));
    let result = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe)
        .and_then(|mut file| file.write_all(b"wegent"));
    let _ = fs::remove_file(&probe);
    result.map_err(|error| format!("{} is not writable: {error}", path.display()))
}

fn validate_existing_record_identity(
    record: &ManagedWorktree,
    path: &Path,
    worktree_id: &str,
    git_common_dir: &Path,
) -> Result<(), String> {
    if !record.worktree_id.is_empty() && record.worktree_id != worktree_id {
        return Err(worktree_target_conflict(format!(
            "Existing managed record belongs to worktree {}",
            record.worktree_id
        )));
    }
    if !record.path.is_empty() && !same_path(&record.path, &path.display().to_string()) {
        return Err(worktree_target_conflict(
            "Existing managed record points to a different path",
        ));
    }
    if let Some(record_common_dir) = record.git_common_dir.as_deref() {
        if canonical_or_normalized(Path::new(record_common_dir))
            != canonical_or_normalized(git_common_dir)
        {
            return Err(worktree_target_conflict(
                "Existing managed record belongs to another repository",
            ));
        }
    } else if let Some(record_source) = record.source_path.as_deref() {
        let record_repository = repository_info(Path::new(record_source))
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        if canonical_or_normalized(&record_repository.git_common_dir)
            != canonical_or_normalized(git_common_dir)
        {
            return Err(worktree_target_conflict(
                "Existing managed record belongs to another repository",
            ));
        }
    }
    Ok(())
}

fn validate_existing_worktree_identity(
    source_path: &Path,
    path: &Path,
    worktree_id: &str,
    expected_git_common_dir: &Path,
) -> Result<(), String> {
    if path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        != Some(worktree_id)
    {
        return Err(worktree_target_conflict(format!(
            "Existing path {} does not belong to worktree {worktree_id}",
            path.display()
        )));
    }
    let git_marker = fs::symlink_metadata(path.join(".git")).map_err(|error| {
        worktree_target_conflict(format!(
            "Existing path {} is not a linked Git worktree: {error}",
            path.display()
        ))
    })?;
    if git_marker.file_type().is_symlink() || !git_marker.is_file() {
        return Err(worktree_target_conflict(format!(
            "Existing path {} is not a linked Git worktree",
            path.display()
        )));
    }
    let target_repository = repository_info(path).map_err(|error| {
        worktree_target_conflict(format!(
            "Existing path {} is not a valid Git worktree: {}: {}",
            path.display(),
            error.code,
            error.message
        ))
    })?;
    let canonical_path = fs::canonicalize(path).map_err(|error| error.to_string())?;
    if target_repository.repo_root != canonical_path {
        return Err(worktree_target_conflict(format!(
            "Existing path {} is not a Git worktree root",
            path.display()
        )));
    }
    if canonical_or_normalized(&target_repository.git_common_dir)
        != canonical_or_normalized(expected_git_common_dir)
    {
        return Err(worktree_target_conflict(format!(
            "Existing path {} belongs to another repository",
            path.display()
        )));
    }
    let source_repository = repository_info(source_path)
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    if canonical_or_normalized(&source_repository.git_common_dir)
        != canonical_or_normalized(expected_git_common_dir)
    {
        return Err(
            "worktree_source_changed: Source repository identity changed during preparation"
                .to_owned(),
        );
    }
    Ok(())
}

fn worktree_target_conflict(message: impl AsRef<str>) -> String {
    format!("worktree_target_conflict: {}", message.as_ref())
}

fn normalize_device_id(device_id: &str) -> String {
    let device_id = device_id.trim();
    if device_id.is_empty() {
        "local-device".to_owned()
    } else {
        device_id.to_owned()
    }
}

fn validate_record_worktree_identity(record: &ManagedWorktree, path: &Path) -> Result<(), String> {
    let expected_git_common_dir = if let Some(git_common_dir) = record.git_common_dir.as_deref() {
        PathBuf::from(git_common_dir)
    } else if let Some(source_path) = record.source_path.as_deref() {
        repository_info(Path::new(source_path))
            .map_err(|error| format!("{}: {}", error.code, error.message))?
            .git_common_dir
    } else {
        return Err("Managed worktree repository identity is unavailable".to_owned());
    };
    let source_path = record
        .source_path
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| path.to_path_buf());
    validate_existing_worktree_identity(
        &source_path,
        path,
        &record.worktree_id,
        &expected_git_common_dir,
    )
}

fn reconcile_worktree_state(
    state: &mut WorktreeState,
    execution_owner_id: &str,
    recover_interrupted_execution: bool,
) -> Result<Vec<WorktreeReconciliation>, String> {
    let mut reconciled = Vec::new();
    for record in state.records.values_mut() {
        let path = PathBuf::from(&record.path);
        if record.state == STATE_PREPARING {
            let result = if path.exists() {
                validate_record_worktree_identity(record, &path)
            } else {
                Err("Worktree preparation was interrupted before the path was created".to_owned())
            };
            match result {
                Ok(()) => {
                    record.state = STATE_ACTIVE.to_owned();
                    record.preparation_owned_path = false;
                    record.last_error = Some(
                        "Recovered a worktree created before Executor interruption; runtime was not resumed"
                            .to_owned(),
                    );
                }
                Err(error) => {
                    record.state = STATE_FAILED.to_owned();
                    record.last_error = Some(error);
                }
            }
            record.updated_at = now_ms();
            reconciled.push(WorktreeReconciliation {
                record: record.clone(),
                interrupted_preparation: true,
                interrupted_execution: false,
                interrupted_execution_task_id: None,
            });
            continue;
        }
        let interrupted_execution = recover_interrupted_execution
            && record
                .execution_lease
                .as_ref()
                .is_some_and(|lease| lease.owner_id != execution_owner_id);
        let interrupted_execution_task_id = if interrupted_execution {
            record
                .execution_lease
                .take()
                .and_then(|lease| (!lease.task_id.is_empty()).then_some(lease.task_id))
        } else {
            None
        };
        if interrupted_execution {
            debug_assert!(record.execution_lease.is_none());
        }
        if record.state == STATE_ACTIVE && path.exists() {
            if let Err(error) = validate_record_worktree_identity(record, &path) {
                record.state = STATE_FAILED.to_owned();
                record.last_error = Some(error);
                record.updated_at = now_ms();
            }
        }
        if interrupted_execution {
            if record.last_error.is_none() {
                record.last_error = Some(
                    "Executor restarted while the Worktree task was executing; runtime was not resumed"
                        .to_owned(),
                );
            }
            record.updated_at = now_ms();
            reconciled.push(WorktreeReconciliation {
                record: record.clone(),
                interrupted_preparation: false,
                interrupted_execution: true,
                interrupted_execution_task_id,
            });
        }
    }
    Ok(reconciled)
}

fn canonical_or_normalized(path: &Path) -> String {
    fs::canonicalize(path)
        .map(|path| normalized_path_key(&path))
        .unwrap_or_else(|_| normalized_path_key(path))
}

fn discover_worktrees(state: &mut WorktreeState, device_id: &str) {
    let roots = state.known_roots.clone();
    for root in roots {
        let root = PathBuf::from(root);
        let Ok(ids) = fs::read_dir(&root) else {
            continue;
        };
        for id in ids.flatten().filter(|entry| entry.path().is_dir()) {
            let id_path = id.path();
            let Ok(repositories) = fs::read_dir(&id_path) else {
                continue;
            };
            for repository in repositories.flatten().filter(|entry| entry.path().is_dir()) {
                let path = repository.path();
                if !path.join(".git").is_file() {
                    continue;
                }
                let key = normalized_path_key(&path);
                state.records.entry(key).or_insert_with(|| ManagedWorktree {
                    worktree_id: id.file_name().to_string_lossy().to_string(),
                    device_id: device_id.to_owned(),
                    path: path.display().to_string(),
                    repository_name: repository.file_name().to_string_lossy().to_string(),
                    ..ManagedWorktree::default()
                });
            }
            let _ = remove_empty_directory(&id_path);
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
    let common_dir = git_common_dir(worktree_path).ok()?;
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

fn git_common_dir(worktree_path: &Path) -> Result<PathBuf, String> {
    let common_dir = PathBuf::from(git_output(
        worktree_path,
        &["rev-parse", "--git-common-dir"],
        None,
    )?);
    let absolute = if common_dir.is_absolute() {
        common_dir
    } else {
        worktree_path.join(common_dir)
    };
    Ok(fs::canonicalize(&absolute).unwrap_or(absolute))
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
    ensure_concrete_absolute_path(root, "Worktree root")?;
    if root.parent().is_none() {
        return Err("Worktree root must be an absolute non-root directory".to_owned());
    }
    Ok(())
}

fn ensure_managed_path(path: &Path, roots: &[String]) -> Result<(), String> {
    ensure_concrete_absolute_path(path, "Worktree path")?;
    let normalized = normalized_path_key(path);
    let matching_root = roots.iter().find_map(|root| {
        let root = Path::new(root);
        if ensure_safe_root(root).is_err() {
            return None;
        }
        let normalized_root = normalized_path_key(root);
        (normalized.starts_with(&format!("{normalized_root}/"))
            && normalized[normalized_root.len() + 1..].split('/').count() == 2)
            .then_some(root)
    });
    let Some(matching_root) = matching_root else {
        return Err("Worktree path is outside managed roots".to_owned());
    };
    if path.exists() {
        let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
        let canonical_root = fs::canonicalize(matching_root).map_err(|error| error.to_string())?;
        if !canonical.starts_with(&canonical_root)
            || contains_symlink_below_root(matching_root, path)?
        {
            return Err("Worktree path resolves outside managed roots".to_owned());
        }
    }
    Ok(())
}

fn ensure_concrete_absolute_path(path: &Path, label: &str) -> Result<(), String> {
    let has_placeholder = path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy();
        value.starts_with('~')
            || value.starts_with('$')
            || (value.len() > 2 && value.starts_with('%') && value.ends_with('%'))
    });
    let has_parent_component = path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir));
    if !path.is_absolute() || has_placeholder || has_parent_component {
        return Err(format!(
            "{label} must be an expanded absolute path without placeholders"
        ));
    }
    Ok(())
}

fn contains_symlink_below_root(root: &Path, path: &Path) -> Result<bool, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Worktree path is outside managed roots".to_owned())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Ok(true);
        }
    }
    Ok(false)
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
    dirs::home_dir().unwrap_or_else(env::temp_dir)
}

fn normalized_path_key(path: &Path) -> String {
    path.to_string_lossy().trim_end_matches('/').to_owned()
}

fn same_path(left: &str, right: &str) -> bool {
    normalized_path_key(Path::new(left)) == normalized_path_key(Path::new(right))
}

fn is_auto_prune_candidate(record: &ManagedWorktree, linked_tasks: &[RuntimeTaskLink]) -> bool {
    record.state == "active"
        && !record.permanent
        && !linked_tasks.is_empty()
        && linked_tasks.iter().all(|task| task.status == "archived")
}

fn select_auto_prune_candidates(
    listed: Vec<(ManagedWorktree, Vec<RuntimeTaskLink>)>,
    tasks: &[RuntimeTaskLink],
    busy_task_repositories: &HashSet<String>,
    keep_count: usize,
    max_removals: usize,
) -> Vec<ManagedWorktree> {
    let protected = tasks
        .iter()
        .filter(|task| task.running || now_ms().saturating_sub(task.updated_at) < 5 * 60 * 1_000)
        .map(|task| normalized_path_key(Path::new(&task.workspace_path)))
        .collect::<HashSet<_>>();
    let mut busy_repositories = listed
        .iter()
        .filter(|(_, linked_tasks)| linked_tasks.iter().any(|task| task.running))
        .filter_map(|(record, _)| repository_identity(record))
        .collect::<HashSet<_>>();
    busy_repositories.extend(busy_task_repositories.iter().cloned());
    let mut active = listed
        .into_iter()
        .filter(|(record, linked_tasks)| is_auto_prune_candidate(record, linked_tasks))
        .map(|(record, _)| record)
        .collect::<Vec<_>>();
    active.sort_by_key(|record| std::cmp::Reverse(record.updated_at));
    active
        .into_iter()
        .skip(keep_count)
        .filter(|record| !protected.contains(&normalized_path_key(Path::new(&record.path))))
        .filter(|record| {
            !repository_identity(record)
                .is_some_and(|repository| busy_repositories.contains(&repository))
        })
        .take(max_removals)
        .collect()
}

fn remove_auto_prune_candidates<F>(
    candidates: Vec<ManagedWorktree>,
    max_removals: usize,
    mut remove: F,
) -> WorktreePruneBatch
where
    F: FnMut(&ManagedWorktree) -> Result<ManagedWorktree, String>,
{
    let mut batch = WorktreePruneBatch::default();
    if max_removals == 0 {
        return batch;
    }
    for record in candidates {
        match remove(&record) {
            Ok(removed) => {
                batch.removed.push(removed);
                if batch.removed.len() >= max_removals {
                    break;
                }
            }
            Err(error) => batch.errors.push(format!("{}: {error}", record.path)),
        }
    }
    batch
}

fn repository_identity(record: &ManagedWorktree) -> Option<String> {
    record
        .source_path
        .as_deref()
        .or(record.git_common_dir.as_deref())
        .map(|path| normalized_path_key(Path::new(path)))
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
    fn capabilities_use_the_frozen_runtime_contract() {
        let root = test_directory("wegent-worktree-capabilities-test");
        let manager = WorktreeManager::new_for_device_with_storage(
            root.join("runtime-work/worktrees.json"),
            "device-local",
            true,
        );
        let capabilities = serde_json::to_value(manager.capabilities()).unwrap();

        assert_eq!(capabilities["version"], RUNTIME_WORKTREES_VERSION);
        assert_eq!(capabilities["managed"], true);
        assert_eq!(capabilities["deferredPrepare"], true);
        assert_eq!(capabilities["snapshots"], true);
        assert_eq!(capabilities["restore"], true);
        assert_eq!(capabilities["preflight"], true);
        assert_eq!(capabilities["reconcile"], true);
        assert_eq!(capabilities["persistentStorageVerified"], true);
        let _ = fs::remove_dir_all(root);
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
    fn managed_path_rejects_unexpanded_or_ambiguous_paths() {
        let roots = vec!["/tmp/wegent-worktrees".to_owned()];

        for path in [
            "/tmp/wegent-worktrees/$TASK/repo",
            "/tmp/wegent-worktrees/${TASK}/repo",
            "/tmp/wegent-worktrees/%TASK%/repo",
            "/tmp/wegent-worktrees/../outside/repo",
            "relative/worktrees/task/repo",
        ] {
            assert!(
                ensure_managed_path(Path::new(path), &roots).is_err(),
                "{path} must not be accepted as a deletion target"
            );
        }
        for path in [
            "/tmp/wegent-worktrees/cost$analysis/repo",
            "/tmp/wegent-worktrees/100%done/repo",
        ] {
            assert!(
                ensure_managed_path(Path::new(path), &roots).is_ok(),
                "{path} is a concrete deletion target"
            );
        }
    }

    #[test]
    fn planned_path_does_not_create_the_worktree() {
        let root = test_directory("wegent-worktree-planned-path-test");
        let source = root.join("source");
        let managed_root = root.join("managed");
        initialize_repository(&source);
        fs::create_dir_all(&managed_root).unwrap();
        let manager = WorktreeManager::new(root.join("runtime-work/worktrees.json"));
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

        let planned = manager.plan(&source, "task-1", None).unwrap().path;

        assert_eq!(planned, managed_root.join("task-1/source"));
        assert!(!planned.exists());
        assert!(manager.list(&[]).unwrap().is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prepare_at_keeps_the_path_planned_before_settings_change() {
        let root = test_directory("wegent-worktree-stable-planned-path-test");
        let source = root.join("source");
        initialize_repository(&source);

        let manager = WorktreeManager::new(root.join("runtime-work/worktrees.json"));
        let original_root = root.join("original");
        manager
            .update_settings(WorktreeSettingsPatch {
                worktree_root: Some(original_root.display().to_string()),
                ..WorktreeSettingsPatch::default()
            })
            .unwrap();
        let planned = manager.plan(&source, "task-1", None).unwrap().path;
        manager
            .update_settings(WorktreeSettingsPatch {
                worktree_root: Some(root.join("updated").display().to_string()),
                ..WorktreeSettingsPatch::default()
            })
            .unwrap();

        let record = manager
            .prepare_at(&source, "task-1", None, false, &planned)
            .unwrap();

        assert_eq!(PathBuf::from(record.path), planned);
        assert!(planned.exists());
        let _ = manager.delete(&planned, false);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn planned_prepare_rejects_a_repository_replaced_at_the_same_path() {
        let root = test_directory("wegent-worktree-source-replaced-test");
        let source = root.join("source");
        let replacement = root.join("replacement");
        initialize_repository(&source);
        initialize_repository(&replacement);
        let manager =
            WorktreeManager::new_for_device(root.join("runtime-work/worktrees.json"), "device-a");
        manager
            .update_settings(WorktreeSettingsPatch {
                worktree_root: Some(root.join("managed").display().to_string()),
                ..WorktreeSettingsPatch::default()
            })
            .unwrap();
        let plan = manager.plan(&source, "task-1", None).unwrap();
        fs::remove_dir_all(&source).unwrap();
        fs::rename(&replacement, &source).unwrap();

        let error = manager
            .prepare_planned(
                &source,
                "task-1",
                None,
                false,
                &plan.path,
                &plan.repo_root_fingerprint,
            )
            .unwrap_err();

        assert_eq!(
            error,
            "worktree_source_changed: Source repository identity changed after planning"
        );
        assert!(!plan.path.exists());
        assert!(manager.load().records.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unverified_persistent_storage_blocks_preflight_plan_and_prepare() {
        let root = test_directory("wegent-worktree-unverified-storage-test");
        let source = root.join("source");
        initialize_repository(&source);
        let manager = WorktreeManager::new_for_device_with_storage(
            root.join("runtime-work/worktrees.json"),
            "device-cloud",
            false,
        );
        let preflight = manager.preflight(&source, None);

        assert!(!manager.capabilities().persistent_storage_verified);
        assert!(!preflight.supported);
        assert!(!preflight.writable);
        assert_eq!(
            preflight.error_code.as_deref(),
            Some("worktree_persistent_storage_unverified")
        );
        for error in [
            manager.plan(&source, "task-1", None).unwrap_err(),
            manager.prepare(&source, "task-1", None, false).unwrap_err(),
        ] {
            assert_eq!(
                error,
                "worktree_persistent_storage_unverified: Persistent Worktree storage is not verified"
            );
        }
        assert!(!root.join("workspace/worktrees/task-1/source").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preflight_reports_repository_identity_without_creating_a_worktree() {
        let root = test_directory("wegent-worktree-preflight-test");
        let source = root.join("source");
        let managed_root = root.join("managed");
        initialize_repository(&source);
        let manager = WorktreeManager::new(root.join("runtime-work/worktrees.json"));
        manager
            .update_settings(WorktreeSettingsPatch {
                worktree_root: Some(managed_root.display().to_string()),
                ..WorktreeSettingsPatch::default()
            })
            .unwrap();

        let preflight = manager.preflight(&source, Some("HEAD"));

        assert!(preflight.supported);
        assert!(preflight.source_exists);
        assert!(preflight.source_directory);
        assert!(preflight.git_repository);
        assert!(preflight.git_common_dir_valid);
        assert!(preflight.git_common_dir_writable);
        assert_eq!(preflight.ref_valid, Some(true));
        assert!(preflight.writable);
        assert_eq!(preflight.error_code, None);
        let fingerprint = preflight.repo_root_fingerprint.unwrap();
        let digest = fingerprint
            .strip_prefix("sha256:")
            .expect("fingerprint must use the sha256 prefix");
        assert_eq!(digest.len(), 64);
        assert!(digest
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
        assert!(manager.load().records.is_empty());
        assert_eq!(fs::read_dir(&managed_root).unwrap().count(), 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preflight_rejects_an_unknown_git_ref() {
        let root = test_directory("wegent-worktree-preflight-ref-test");
        let source = root.join("source");
        initialize_repository(&source);
        let manager = WorktreeManager::new(root.join("runtime-work/worktrees.json"));
        manager
            .update_settings(WorktreeSettingsPatch {
                worktree_root: Some(root.join("managed").display().to_string()),
                ..WorktreeSettingsPatch::default()
            })
            .unwrap();

        let preflight = manager.preflight(&source, Some("refs/heads/missing"));

        assert!(preflight.git_repository);
        assert_eq!(preflight.ref_valid, Some(false));
        assert!(!preflight.writable);
        assert_eq!(
            preflight.error_code.as_deref(),
            Some("worktree_ref_not_found")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prepare_rejects_an_existing_plain_directory_and_persists_failure() {
        let root = test_directory("wegent-worktree-existing-directory-test");
        let source = root.join("source");
        initialize_repository(&source);
        let manager = WorktreeManager::new(root.join("runtime-work/worktrees.json"));
        manager
            .update_settings(WorktreeSettingsPatch {
                worktree_root: Some(root.join("managed").display().to_string()),
                ..WorktreeSettingsPatch::default()
            })
            .unwrap();
        let planned = manager.plan(&source, "task-1", None).unwrap().path;
        fs::create_dir_all(&planned).unwrap();

        let error = manager
            .prepare_at(&source, "task-1", None, false, &planned)
            .unwrap_err();

        assert!(error.starts_with("worktree_target_conflict:"));
        let record = manager
            .load()
            .records
            .remove(&normalized_path_key(&planned))
            .expect("failed preparation must remain diagnosable");
        assert_eq!(record.state, STATE_FAILED);
        assert!(!record.preparation_owned_path);
        assert_eq!(record.last_error.as_deref(), Some(error.as_str()));
        assert!(manager
            .discard_failed_preparation(&planned, "task-1")
            .unwrap_err()
            .contains("Pre-existing target"));
        assert!(planned.exists(), "unknown directories must not be removed");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn discard_failed_preparation_removes_only_the_owned_partial_target() {
        let root = test_directory("wegent-worktree-owned-failed-preparation-test");
        let source = root.join("source");
        let managed_root = root.join("managed");
        let planned = managed_root.join("task-1/source");
        initialize_repository(&source);
        fs::create_dir_all(&planned).unwrap();
        fs::write(planned.join("partial.txt"), "partial\n").unwrap();
        let manager = WorktreeManager::new(root.join("runtime-work/worktrees.json"));
        let record = ManagedWorktree {
            worktree_id: "task-1".to_owned(),
            path: planned.display().to_string(),
            repository_name: "source".to_owned(),
            source_path: Some(source.display().to_string()),
            preparation_owned_path: true,
            state: STATE_FAILED.to_owned(),
            last_error: Some("interrupted".to_owned()),
            ..ManagedWorktree::default()
        };
        manager
            .save(&WorktreeState {
                version: STATE_VERSION,
                settings: WorktreeSettings {
                    worktree_root: managed_root.display().to_string(),
                    resolved_worktree_root: managed_root.display().to_string(),
                    ..WorktreeSettings::default()
                },
                known_roots: vec![managed_root.display().to_string()],
                records: HashMap::from([(normalized_path_key(&planned), record)]),
            })
            .unwrap();

        let discarded = manager
            .discard_failed_preparation(&planned, "task-1")
            .unwrap()
            .expect("owned failed preparation should be discarded");

        assert_eq!(discarded.state, STATE_DELETED);
        assert!(!discarded.preparation_owned_path);
        assert!(!planned.exists());
        assert!(!planned.parent().unwrap().exists());
        let persisted = manager
            .load()
            .records
            .remove(&normalized_path_key(&planned))
            .unwrap();
        assert_eq!(persisted.state, STATE_DELETED);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prepare_rejects_an_existing_worktree_from_another_repository() {
        let root = test_directory("wegent-worktree-wrong-repository-test");
        let source = root.join("source");
        let other = root.join("other");
        initialize_repository(&source);
        initialize_repository(&other);
        let manager = WorktreeManager::new(root.join("runtime-work/worktrees.json"));
        manager
            .update_settings(WorktreeSettingsPatch {
                worktree_root: Some(root.join("managed").display().to_string()),
                ..WorktreeSettingsPatch::default()
            })
            .unwrap();
        let planned = manager.plan(&source, "task-1", None).unwrap().path;
        run_git(
            &other,
            &["worktree", "add", "--detach", planned.to_str().unwrap()],
        );

        let error = manager
            .prepare_at(&source, "task-1", None, false, &planned)
            .unwrap_err();

        assert!(error.contains("another repository"));
        let record = manager
            .load()
            .records
            .remove(&normalized_path_key(&planned))
            .expect("failed preparation must remain diagnosable");
        assert_eq!(record.state, STATE_FAILED);
        run_git(
            &other,
            &["worktree", "remove", "--force", planned.to_str().unwrap()],
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reconcile_recovers_a_valid_preparing_worktree_without_resuming_runtime() {
        let root = test_directory("wegent-worktree-reconcile-valid-test");
        let source = root.join("source");
        initialize_repository(&source);
        let manager = WorktreeManager::new(root.join("runtime-work/worktrees.json"));
        manager
            .update_settings(WorktreeSettingsPatch {
                worktree_root: Some(root.join("managed").display().to_string()),
                ..WorktreeSettingsPatch::default()
            })
            .unwrap();
        let plan = manager.plan(&source, "task-1", None).unwrap();
        run_git(
            &source,
            &["worktree", "add", "--detach", plan.path.to_str().unwrap()],
        );
        let repository = repository_info(&source).unwrap();
        let mut state = manager.load();
        state.records.insert(
            normalized_path_key(&plan.path),
            ManagedWorktree {
                worktree_id: "task-1".to_owned(),
                path: plan.path.display().to_string(),
                repository_name: "source".to_owned(),
                source_path: Some(repository.repo_root.display().to_string()),
                git_common_dir: Some(repository.git_common_dir.display().to_string()),
                state: STATE_PREPARING.to_owned(),
                ..ManagedWorktree::default()
            },
        );
        manager.save(&state).unwrap();

        let reconciled = manager.reconcile().unwrap();

        assert_eq!(reconciled.len(), 1);
        assert!(reconciled[0].interrupted_preparation);
        assert_eq!(reconciled[0].record.state, STATE_ACTIVE);
        assert!(reconciled[0]
            .record
            .last_error
            .as_deref()
            .unwrap()
            .contains("runtime was not resumed"));
        run_git(
            &source,
            &["worktree", "remove", "--force", plan.path.to_str().unwrap()],
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reconcile_marks_a_missing_preparing_worktree_failed() {
        let root = test_directory("wegent-worktree-reconcile-missing-test");
        let source = root.join("source");
        initialize_repository(&source);
        let manager = WorktreeManager::new(root.join("runtime-work/worktrees.json"));
        manager
            .update_settings(WorktreeSettingsPatch {
                worktree_root: Some(root.join("managed").display().to_string()),
                ..WorktreeSettingsPatch::default()
            })
            .unwrap();
        let plan = manager.plan(&source, "task-1", None).unwrap();
        let repository = repository_info(&source).unwrap();
        let mut state = manager.load();
        state.records.insert(
            normalized_path_key(&plan.path),
            ManagedWorktree {
                worktree_id: "task-1".to_owned(),
                path: plan.path.display().to_string(),
                repository_name: "source".to_owned(),
                source_path: Some(repository.repo_root.display().to_string()),
                git_common_dir: Some(repository.git_common_dir.display().to_string()),
                state: STATE_PREPARING.to_owned(),
                ..ManagedWorktree::default()
            },
        );
        manager.save(&state).unwrap();

        let reconciled = manager.reconcile().unwrap();

        assert_eq!(reconciled.len(), 1);
        assert_eq!(reconciled[0].record.state, STATE_FAILED);
        assert!(reconciled[0]
            .record
            .last_error
            .as_deref()
            .unwrap()
            .contains("before the path was created"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn different_device_id_does_not_block_managed_worktree_operations() {
        let root = test_directory("wegent-worktree-device-id-metadata-test");
        let source = root.join("source");
        initialize_repository(&source);
        let state_path = root.join("runtime-work/worktrees.json");
        let manager = WorktreeManager::new_for_device(state_path.clone(), "device-a");
        manager
            .update_settings(WorktreeSettingsPatch {
                worktree_root: Some(root.join("managed").display().to_string()),
                ..WorktreeSettingsPatch::default()
            })
            .unwrap();
        let record = manager.prepare(&source, "task-1", None, false).unwrap();
        let key = normalized_path_key(Path::new(&record.path));
        let mut persisted: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
        persisted["records"][&key]["deviceId"] = Value::String("legacy-device".to_owned());
        fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap()).unwrap();

        let restarted = WorktreeManager::new_for_device(state_path.clone(), "device-b");
        restarted.reconcile().unwrap();
        restarted
            .begin_execution(Path::new(&record.path), "task-1", 1)
            .unwrap();
        assert!(restarted
            .finish_execution(Path::new(&record.path), "task-1", 1)
            .unwrap());

        let persisted: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
        assert_eq!(persisted["records"][&key]["deviceId"], "legacy-device");
        let deleted = restarted.delete(Path::new(&record.path), true).unwrap();
        assert_eq!(deleted.device_id, "legacy-device");
        let restored = restarted.restore(Path::new(&record.path)).unwrap();
        assert_eq!(restored.device_id, "legacy-device");
        restarted.delete(Path::new(&record.path), false).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn managed_path_rejects_symlinks_below_the_managed_root() {
        let root = test_directory("wegent-worktree-symlink-test");
        let managed_root = root.join("managed");
        let target = managed_root.join("target/repo");
        fs::create_dir_all(&managed_root).unwrap();
        fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(managed_root.join("target"), managed_root.join("task")).unwrap();
        let roots = vec![managed_root.display().to_string()];

        assert!(ensure_managed_path(&managed_root.join("task/repo"), &roots).is_err());
        let _ = fs::remove_dir_all(root);
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
        let record = manager.prepare(&source, "task-1", None, false).unwrap();
        let path = PathBuf::from(&record.path);
        fs::write(path.join("tracked.txt"), "changed\n").unwrap();
        fs::write(path.join("untracked.txt"), "new\n").unwrap();

        let deleted = manager.delete(&path, true).unwrap();
        assert_eq!(deleted.state, "restorable");
        assert!(!path.exists());
        assert!(
            !path.parent().unwrap().exists(),
            "deleting a worktree must remove its empty runtime container"
        );

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
    fn delete_without_snapshot_forgets_record_and_existing_snapshot_ref() {
        let root = test_directory("wegent-worktree-terminal-cleanup-test");
        let source = root.join("source");
        initialize_repository(&source);
        let manager = WorktreeManager::new(root.join("runtime-work/worktrees.json"));
        manager
            .update_settings(WorktreeSettingsPatch {
                worktree_root: Some(root.join("managed").display().to_string()),
                ..WorktreeSettingsPatch::default()
            })
            .unwrap();
        let record = manager.prepare(&source, "task-1", None, false).unwrap();
        let path = PathBuf::from(&record.path);
        fs::write(path.join("untracked.txt"), "new\n").unwrap();

        let snapshotted = manager.delete(&path, true).unwrap();
        let snapshot_ref = snapshotted
            .snapshot_ref
            .clone()
            .expect("snapshot deletion must retain a restorable reference");
        manager.restore(&path).unwrap();

        let deleted = manager.delete(&path, false).unwrap();

        assert_eq!(deleted.state, STATE_DELETED);
        assert_eq!(deleted.snapshot_ref, None);
        assert_eq!(deleted.snapshot_commit, None);
        assert_eq!(deleted.snapshot_at, None);
        assert!(!path.exists());
        assert!(!manager
            .load()
            .records
            .contains_key(&normalized_path_key(&path)));
        assert!(manager.list(&[]).unwrap().is_empty());
        assert!(git_output(&source, &["rev-parse", "--verify", &snapshot_ref], None).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn discovery_removes_legacy_empty_worktree_containers() {
        let root = test_directory("wegent-empty-worktree-container-test");
        let managed_root = root.join("managed");
        let empty_container = managed_root.join("stale-task");
        fs::create_dir_all(&empty_container).unwrap();
        let manager = WorktreeManager::new(root.join("runtime-work/worktrees.json"));
        manager
            .update_settings(WorktreeSettingsPatch {
                worktree_root: Some(managed_root.display().to_string()),
                ..WorktreeSettingsPatch::default()
            })
            .unwrap();

        manager.list(&[]).unwrap();

        assert!(
            !empty_container.exists(),
            "discovering worktrees must remove legacy empty runtime containers"
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
        assert!(is_auto_prune_candidate(&record, &[archived_task.clone()]));
        assert!(!is_auto_prune_candidate(&record, &[]));
        assert!(!is_auto_prune_candidate(
            &ManagedWorktree {
                permanent: true,
                ..record
            },
            &[archived_task]
        ));
    }

    #[test]
    fn auto_prune_runs_with_active_tasks_and_avoids_their_repository() {
        let source_a = "/tmp/source-a";
        let source_b = "/tmp/source-b";
        let newest_a = worktree_record("newest-a", source_a, 30);
        let old_a = worktree_record("old-a", source_a, 20);
        let old_b = worktree_record("old-b", source_b, 10);
        let running_b = worktree_record("running-b", source_b, 40);
        let archived = |id: &str, path: &str| {
            let mut task = task_link(id);
            task.status = "archived".to_owned();
            task.workspace_path = path.to_owned();
            task
        };
        let mut running_task = task_link("running");
        running_task.running = true;
        running_task.workspace_path = running_b.path.clone();
        let listed = vec![
            (
                newest_a.clone(),
                vec![archived("archived-newest-a", &newest_a.path)],
            ),
            (old_a.clone(), vec![archived("archived-old-a", &old_a.path)]),
            (old_b.clone(), vec![archived("archived-old-b", &old_b.path)]),
            (running_b, vec![running_task.clone()]),
        ];

        let selected = select_auto_prune_candidates(listed, &[running_task], &HashSet::new(), 1, 1);

        assert_eq!(
            selected
                .iter()
                .map(|record| record.path.as_str())
                .collect::<Vec<_>>(),
            vec![old_a.path.as_str()]
        );
    }

    #[test]
    fn auto_prune_avoids_source_repository_used_by_a_running_task() {
        let source_a = "/tmp/source-a";
        let source_b = "/tmp/source-b";
        let newest_a = worktree_record("newest-a", source_a, 30);
        let old_a = worktree_record("old-a", source_a, 20);
        let old_b = worktree_record("old-b", source_b, 10);
        let archived = |id: &str, path: &str| {
            let mut task = task_link(id);
            task.status = "archived".to_owned();
            task.workspace_path = path.to_owned();
            task
        };
        let listed = vec![
            (
                newest_a.clone(),
                vec![archived("archived-newest-a", &newest_a.path)],
            ),
            (old_a.clone(), vec![archived("archived-old-a", &old_a.path)]),
            (old_b.clone(), vec![archived("archived-old-b", &old_b.path)]),
        ];
        let busy_task_repositories = HashSet::from([source_a.to_owned()]);

        let selected = select_auto_prune_candidates(listed, &[], &busy_task_repositories, 1, 1);

        assert_eq!(
            selected
                .iter()
                .map(|record| record.path.as_str())
                .collect::<Vec<_>>(),
            vec![old_b.path.as_str()]
        );
    }

    #[test]
    fn auto_prune_skips_failed_candidate_and_removes_the_next_one() {
        let failed = worktree_record("failed", "/tmp/source-a", 20);
        let removable = worktree_record("removable", "/tmp/source-b", 10);

        let batch =
            remove_auto_prune_candidates(vec![failed.clone(), removable.clone()], 1, |record| {
                if record.path == failed.path {
                    Err("simulated delete failure".to_owned())
                } else {
                    Ok(record.clone())
                }
            });

        assert_eq!(batch.removed.len(), 1);
        assert_eq!(batch.removed[0].path, removable.path);
        assert_eq!(batch.errors.len(), 1);
        assert!(batch.errors[0].contains(&failed.path));
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

    #[test]
    fn source_path_lookup_survives_missing_worktree_git_metadata() {
        let root = test_directory("wegent-worktree-source-lookup-test");
        let manager = WorktreeManager::new(root.join("runtime-work/worktrees.json"));
        let worktree_path = root.join("managed/task-1/project");
        let source_path = root.join("source/project");
        let mut records = HashMap::new();
        records.insert(
            normalized_path_key(&worktree_path),
            ManagedWorktree {
                path: worktree_path.display().to_string(),
                source_path: Some(source_path.display().to_string()),
                ..ManagedWorktree::default()
            },
        );
        manager
            .save(&WorktreeState {
                version: STATE_VERSION,
                records,
                ..WorktreeState::default()
            })
            .unwrap();

        assert_eq!(
            manager.source_path_for(&worktree_path.display().to_string()),
            Some(source_path.display().to_string())
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
        crate::process::hide_windows_console(&mut command);
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

    fn initialize_repository(path: &Path) {
        fs::create_dir_all(path).unwrap();
        run_git(path, &["init"]);
        run_git(path, &["config", "user.name", "Wegent Test"]);
        run_git(path, &["config", "user.email", "test@wegent.local"]);
        fs::write(path.join("tracked.txt"), "base\n").unwrap();
        run_git(path, &["add", "."]);
        run_git(path, &["commit", "-m", "base"]);
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
            continuable: true,
            thread_status: "notLoaded".to_owned(),
            turn_status: None,
            goal_status: None,
            supervisor: None,
            git_info: None,
            created_at: 0,
            updated_at: 0,
            completed_at: None,
            runtime_handle: Value::Null,
            parent: None,
            ephemeral: false,
            runtime_project_key: None,
            runtime_workspace_roots: Vec::new(),
            project_instructions: String::new(),
            project_plugin_ids: Vec::new(),
            list_order: None,
            sidebar_order: None,
            group_workspace_path: None,
            group_project_key: None,
            pinned: false,
            pinned_order: None,
        }
    }

    fn worktree_record(id: &str, source_path: &str, updated_at: i64) -> ManagedWorktree {
        ManagedWorktree {
            worktree_id: id.to_owned(),
            path: format!("/tmp/worktrees/{id}/repository"),
            repository_name: "repository".to_owned(),
            source_path: Some(source_path.to_owned()),
            updated_at,
            state: "active".to_owned(),
            ..ManagedWorktree::default()
        }
    }
}
