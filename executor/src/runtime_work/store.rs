// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    cmp::Reverse,
    collections::HashMap,
    env,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::response::{RuntimeTaskLink, RuntimeWorkspaceLink};

const INDEX_VERSION: u64 = 1;
const DELETED_ARCHIVED_TASK_ID_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
const DELETED_ARCHIVED_TASK_ID_MAX_COUNT: usize = 2_000;
const PERSISTED_RUNTIME_HANDLE_KEYS: &[&str] = &[
    "cloudProjectId",
    "cloud_project_id",
    "cloudTranscript",
    "executionRequest",
    "execution_request",
    "executorSession",
    "goal",
    "lastTurnId",
    "modelSelection",
    "model_selection",
    "origin",
    "runtime",
    "supersededTranscriptTurnIds",
    "threadPath",
    "wegentTeam",
    "turnIdsBySubtask",
    "userMessagePresentations",
];
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub(crate) struct RuntimeWorkStore {
    index_path: PathBuf,
    index: Arc<Mutex<RuntimeWorkIndex>>,
    index_signature: Arc<Mutex<Option<IndexFileSignature>>>,
    write_lock: Arc<Mutex<()>>,
    last_written_payload: Arc<Mutex<Option<Vec<u8>>>>,
    #[cfg(test)]
    write_attempts: Arc<AtomicU64>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
struct RuntimeWorkIndex {
    version: u64,
    tasks: HashMap<String, RuntimeTaskLink>,
    workspaces: HashMap<String, RuntimeWorkspaceLink>,
    #[serde(default, deserialize_with = "deserialize_deleted_archived_task_ids")]
    deleted_archived_task_ids: HashMap<String, i64>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
struct PersistedRuntimeWorkIndex {
    version: u64,
    tasks: HashMap<String, PersistedRuntimeTask>,
    workspaces: HashMap<String, RuntimeWorkspaceLink>,
    #[serde(default, deserialize_with = "deserialize_deleted_archived_task_ids")]
    deleted_archived_task_ids: HashMap<String, i64>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(from = "PersistedRuntimeTaskInput")]
#[serde(default)]
struct PersistedRuntimeTask {
    local_task_id: String,
    thread_id: Option<String>,
    workspace_path: String,
    title: String,
    runtime: String,
    archived: bool,
    continuable: bool,
    goal_status: Option<String>,
    supervisor: Option<super::response::RuntimeSupervisorState>,
    created_at: i64,
    updated_at: i64,
    runtime_handle: Value,
    parent: Option<Value>,
    ephemeral: bool,
    runtime_project_key: Option<String>,
    runtime_workspace_roots: Vec<String>,
    project_instructions: String,
    project_plugin_ids: Vec<String>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct PersistedRuntimeTaskInput {
    local_task_id: String,
    thread_id: Option<String>,
    workspace_path: String,
    title: String,
    runtime: String,
    archived: bool,
    status: Option<String>,
    continuable: bool,
    goal_status: Option<String>,
    supervisor: Option<super::response::RuntimeSupervisorState>,
    created_at: i64,
    updated_at: i64,
    runtime_handle: Value,
    parent: Option<Value>,
    ephemeral: bool,
    runtime_project_key: Option<String>,
    runtime_workspace_roots: Vec<String>,
    project_instructions: String,
    project_plugin_ids: Vec<String>,
}

impl From<PersistedRuntimeTaskInput> for PersistedRuntimeTask {
    fn from(input: PersistedRuntimeTaskInput) -> Self {
        Self {
            local_task_id: input.local_task_id,
            thread_id: input.thread_id,
            workspace_path: input.workspace_path,
            title: input.title,
            runtime: input.runtime,
            archived: input.archived
                || input
                    .status
                    .as_deref()
                    .is_some_and(|status| status.eq_ignore_ascii_case("archived")),
            continuable: input.continuable,
            goal_status: input.goal_status,
            supervisor: input.supervisor,
            created_at: input.created_at,
            updated_at: input.updated_at,
            runtime_handle: input.runtime_handle,
            parent: input.parent,
            ephemeral: input.ephemeral,
            runtime_project_key: input.runtime_project_key,
            runtime_workspace_roots: input.runtime_workspace_roots,
            project_instructions: input.project_instructions,
            project_plugin_ids: input.project_plugin_ids,
        }
    }
}

impl PersistedRuntimeTask {
    fn from_runtime(link: &RuntimeTaskLink) -> Self {
        Self {
            local_task_id: link.local_task_id.clone(),
            thread_id: link.thread_id.clone(),
            workspace_path: link.workspace_path.clone(),
            title: link.title.clone(),
            runtime: link.runtime.clone(),
            archived: link.status == "archived",
            continuable: link.continuable,
            goal_status: link.goal_status.clone(),
            supervisor: link.supervisor.clone(),
            created_at: link.created_at,
            updated_at: link.updated_at,
            runtime_handle: persisted_runtime_handle(&link.runtime_handle),
            parent: link.parent.clone(),
            ephemeral: link.ephemeral,
            runtime_project_key: link.runtime_project_key.clone(),
            runtime_workspace_roots: link.runtime_workspace_roots.clone(),
            project_instructions: link.project_instructions.clone(),
            project_plugin_ids: link.project_plugin_ids.clone(),
        }
    }

    fn into_runtime(self) -> RuntimeTaskLink {
        RuntimeTaskLink {
            local_task_id: self.local_task_id,
            thread_id: self.thread_id,
            workspace_path: self.workspace_path,
            title: self.title,
            runtime: self.runtime,
            status: if self.archived {
                "archived".to_owned()
            } else {
                "active".to_owned()
            },
            running: false,
            continuable: self.continuable,
            thread_status: "notLoaded".to_owned(),
            turn_status: None,
            goal_status: self.goal_status,
            supervisor: self.supervisor,
            git_info: None,
            created_at: self.created_at,
            updated_at: self.updated_at,
            completed_at: None,
            runtime_handle: persisted_runtime_handle(&self.runtime_handle),
            parent: self.parent,
            ephemeral: self.ephemeral,
            runtime_project_key: self.runtime_project_key,
            runtime_workspace_roots: self.runtime_workspace_roots,
            project_instructions: self.project_instructions,
            project_plugin_ids: self.project_plugin_ids,
            list_order: None,
            sidebar_order: None,
            group_workspace_path: None,
            group_project_key: None,
            pinned: false,
            pinned_order: None,
        }
    }

    fn apply_to(self, task: &mut RuntimeTaskLink) {
        task.thread_id = self.thread_id;
        task.workspace_path = self.workspace_path;
        task.title = self.title;
        task.runtime = self.runtime;
        task.continuable = self.continuable;
        task.goal_status = self.goal_status;
        task.supervisor = self.supervisor;
        task.created_at = self.created_at;
        task.updated_at = self.updated_at;
        task.runtime_handle =
            merge_persisted_runtime_handle(&task.runtime_handle, self.runtime_handle);
        task.parent = self.parent;
        task.ephemeral = self.ephemeral;
        task.runtime_project_key = self.runtime_project_key;
        task.runtime_workspace_roots = self.runtime_workspace_roots;
        task.project_instructions = self.project_instructions;
        task.project_plugin_ids = self.project_plugin_ids;

        if self.archived {
            task.status = "archived".to_owned();
        } else if task.status == "archived" {
            task.status = "active".to_owned();
        }
    }
}

fn persisted_runtime_handle(runtime_handle: &Value) -> Value {
    let mut persisted = runtime_handle
        .as_object()
        .into_iter()
        .flat_map(|runtime_handle| runtime_handle.iter())
        .filter(|(key, _)| PERSISTED_RUNTIME_HANDLE_KEYS.contains(&key.as_str()))
        .filter(|(key, _)| key.as_str() != "wegentTeam")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<serde_json::Map<String, Value>>();
    if let Some(team_id) = runtime_handle
        .get("wegentTeam")
        .and_then(|team| team.get("id"))
        .cloned()
    {
        persisted.insert(
            "wegentTeam".to_owned(),
            serde_json::json!({ "id": team_id }),
        );
    }
    Value::Object(persisted)
}

fn merge_persisted_runtime_handle(current: &Value, persisted: Value) -> Value {
    let mut merged = persisted_runtime_handle(&persisted)
        .as_object()
        .cloned()
        .unwrap_or_default();
    let current = current.as_object();
    for key in ["queuePosition", "lastError", "lastErrorCode"] {
        if let Some(value) = current.and_then(|runtime_handle| runtime_handle.get(key)) {
            merged.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(merged)
}

fn persisted_task_fingerprint(task: &RuntimeTaskLink) -> Vec<u8> {
    let mut persisted = PersistedRuntimeTask::from_runtime(task);
    persisted.updated_at = 0;
    serde_json::to_vec(&persisted).unwrap_or_default()
}

fn persisted_index_requires_migration(index: &PersistedRuntimeWorkIndex) -> bool {
    index
        .tasks
        .values()
        .any(|task| task.runtime_handle != persisted_runtime_handle(&task.runtime_handle))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct IndexFileSignature {
    len: u64,
    modified_ms: u128,
}

impl RuntimeWorkStore {
    pub fn new(index_path: PathBuf) -> Self {
        let persisted_index = read_persisted_index_from_path(&index_path);
        let migration_required = persisted_index_requires_migration(&persisted_index);
        let index = persisted_index_into_runtime(persisted_index);
        let index_signature = index_file_signature(&index_path);
        let last_written_payload = (!migration_required)
            .then(|| serialize_index(&index).ok())
            .flatten();
        let store = Self {
            index_path,
            index: Arc::new(Mutex::new(index)),
            index_signature: Arc::new(Mutex::new(index_signature)),
            write_lock: Arc::new(Mutex::new(())),
            last_written_payload: Arc::new(Mutex::new(last_written_payload)),
            #[cfg(test)]
            write_attempts: Arc::new(AtomicU64::new(0)),
        };
        if migration_required {
            store.persist_current_index();
        }
        store
    }

    pub fn from_env() -> Self {
        Self::new(default_index_path())
    }

    pub fn list_task_summaries(&self, include_archived: bool) -> Vec<RuntimeTaskLink> {
        self.refresh_index_from_disk_if_changed();
        let Some(index) = self.index.lock().ok() else {
            return Vec::new();
        };
        let mut tasks = index
            .tasks
            .values()
            .filter(|task| include_archived || task.status != "archived")
            .map(RuntimeTaskLink::list_summary)
            .collect::<Vec<_>>();
        tasks.sort_by_key(|task| Reverse(task.updated_at));
        tasks
    }

    pub fn get_task(&self, local_task_id: &str) -> Option<RuntimeTaskLink> {
        self.refresh_index_from_disk_if_changed();
        self.index.lock().ok()?.tasks.get(local_task_id).cloned()
    }

    pub fn find_summary_by_thread_id(&self, thread_id: &str) -> Option<RuntimeTaskLink> {
        self.refresh_index_from_disk_if_changed();
        self.index
            .lock()
            .ok()?
            .tasks
            .values()
            .find(|link| link.thread_id.as_deref() == Some(thread_id))
            .map(RuntimeTaskLink::list_summary)
    }

    pub fn is_deleted_archived_task_id(&self, task_id: &str) -> bool {
        self.refresh_index_from_disk_if_changed();
        let Some(mut index) = self.index.lock().ok() else {
            return false;
        };
        let before_deleted_count = index.deleted_archived_task_ids.len();
        prune_deleted_archived_task_ids(&mut index.deleted_archived_task_ids, current_time_ms());
        let deleted = index.deleted_archived_task_ids.contains_key(task_id);
        let should_persist = index.deleted_archived_task_ids.len() != before_deleted_count;
        drop(index);
        if should_persist {
            self.persist_current_index();
        }
        deleted
    }

    pub fn mark_deleted_archived_task_ids(&self, task_ids: impl IntoIterator<Item = String>) {
        self.refresh_index_from_disk_if_changed();
        let Some(mut index) = self.index.lock().ok() else {
            return;
        };
        let now_ms = current_time_ms();
        for task_id in task_ids {
            if !task_id.trim().is_empty() {
                index.deleted_archived_task_ids.insert(task_id, now_ms);
            }
        }
        prune_deleted_archived_task_ids(&mut index.deleted_archived_task_ids, now_ms);
        drop(index);
        self.persist_current_index();
    }

    pub fn upsert_task(&self, link: RuntimeTaskLink) {
        self.refresh_index_from_disk_if_changed();
        let Some(mut index) = self.index.lock().ok() else {
            return;
        };
        index.tasks.insert(link.local_task_id.clone(), link);
        drop(index);
        self.persist_current_index();
    }

    pub fn update_task(
        &self,
        local_task_id: &str,
        updater: impl FnOnce(&mut RuntimeTaskLink),
    ) -> Option<RuntimeTaskLink> {
        self.update_task_with_persistence(local_task_id, updater, true)
    }

    fn update_task_with_persistence(
        &self,
        local_task_id: &str,
        updater: impl FnOnce(&mut RuntimeTaskLink),
        persist: bool,
    ) -> Option<RuntimeTaskLink> {
        self.refresh_index_from_disk_if_changed();
        let mut index = self.index.lock().ok()?;
        let task = index.tasks.get_mut(local_task_id)?;
        let before = persisted_task_fingerprint(task);
        updater(task);
        let updated = task.clone();
        let should_persist = persist && before != persisted_task_fingerprint(task);
        drop(index);
        if should_persist {
            self.persist_current_index();
        }
        Some(updated)
    }

    pub fn delete_task(&self, local_task_id: &str) -> Option<RuntimeTaskLink> {
        self.refresh_index_from_disk_if_changed();
        let mut index = self.index.lock().ok()?;
        let removed = index.tasks.remove(local_task_id)?;
        drop(index);
        self.persist_current_index();
        Some(removed)
    }

    fn persist_current_index(&self) {
        let Ok(_write_guard) = self.write_lock.lock() else {
            return;
        };
        let payload = {
            let Ok(index) = self.index.lock() else {
                return;
            };
            match serialize_index(&index) {
                Ok(payload) => payload,
                Err(error) => {
                    eprintln!(
                        "[runtime-work-store] failed to serialize index {}: {error}",
                        self.index_path.display()
                    );
                    return;
                }
            }
        };
        if self
            .last_written_payload
            .lock()
            .ok()
            .is_some_and(|last_payload| last_payload.as_ref() == Some(&payload))
        {
            return;
        }

        #[cfg(test)]
        self.write_attempts.fetch_add(1, Ordering::Relaxed);
        if let Err(error) = atomic_write_file(&self.index_path, &payload) {
            eprintln!(
                "[runtime-work-store] failed to persist index {}: {error}",
                self.index_path.display()
            );
            return;
        }
        if let Ok(mut last_payload) = self.last_written_payload.lock() {
            *last_payload = Some(payload);
        }
        self.update_index_signature();
    }

    fn refresh_index_from_disk_if_changed(&self) {
        let Ok(_write_guard) = self.write_lock.lock() else {
            return;
        };
        let current_signature = index_file_signature(&self.index_path);
        let changed = self
            .index_signature
            .lock()
            .ok()
            .is_some_and(|signature| *signature != current_signature);
        if !changed {
            return;
        }

        let persisted_index = read_persisted_index_from_path(&self.index_path);
        if let Ok(mut index) = self.index.lock() {
            merge_persisted_index(&mut index, persisted_index);
        }
        if let Ok(mut last_payload) = self.last_written_payload.lock() {
            *last_payload = None;
        }
        if let Ok(mut signature) = self.index_signature.lock() {
            *signature = current_signature;
        }
    }

    fn update_index_signature(&self) {
        if let Ok(mut signature) = self.index_signature.lock() {
            *signature = index_file_signature(&self.index_path);
        }
    }
}

fn current_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn read_persisted_index_from_path(index_path: &Path) -> PersistedRuntimeWorkIndex {
    let Ok(content) = fs::read_to_string(index_path) else {
        return PersistedRuntimeWorkIndex::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn persisted_index_into_runtime(persisted: PersistedRuntimeWorkIndex) -> RuntimeWorkIndex {
    RuntimeWorkIndex {
        version: persisted.version,
        tasks: persisted
            .tasks
            .into_iter()
            .map(|(task_id, task)| (task_id, task.into_runtime()))
            .collect(),
        workspaces: persisted.workspaces,
        deleted_archived_task_ids: persisted.deleted_archived_task_ids,
    }
}

fn merge_persisted_index(current: &mut RuntimeWorkIndex, persisted: PersistedRuntimeWorkIndex) {
    current
        .tasks
        .retain(|task_id, _| persisted.tasks.contains_key(task_id));
    for (task_id, persisted_task) in persisted.tasks {
        if let Some(task) = current.tasks.get_mut(&task_id) {
            persisted_task.apply_to(task);
        } else {
            current.tasks.insert(task_id, persisted_task.into_runtime());
        }
    }
    current.version = persisted.version;
    current.workspaces = persisted.workspaces;
    current.deleted_archived_task_ids = persisted.deleted_archived_task_ids;
}

fn serialize_index(index: &RuntimeWorkIndex) -> Result<Vec<u8>, serde_json::Error> {
    let mut deleted_archived_task_ids = index.deleted_archived_task_ids.clone();
    prune_deleted_archived_task_ids(&mut deleted_archived_task_ids, current_time_ms());
    serde_json::to_vec(&PersistedRuntimeWorkIndex {
        version: INDEX_VERSION,
        tasks: index
            .tasks
            .iter()
            .map(|(task_id, task)| (task_id.clone(), PersistedRuntimeTask::from_runtime(task)))
            .collect(),
        workspaces: index.workspaces.clone(),
        deleted_archived_task_ids,
    })
}

fn index_file_signature(index_path: &Path) -> Option<IndexFileSignature> {
    let metadata = fs::metadata(index_path).ok()?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    Some(IndexFileSignature {
        len: metadata.len(),
        modified_ms,
    })
}

fn deserialize_deleted_archived_task_ids<'de, D>(
    deserializer: D,
) -> Result<HashMap<String, i64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    let now_ms = current_time_ms();
    let mut ids = match value {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|item| item.as_str().map(|id| (id.to_owned(), now_ms)))
            .collect::<HashMap<_, _>>(),
        Value::Object(entries) => entries
            .into_iter()
            .filter_map(|(id, value)| timestamp_from_value(&value).map(|timestamp| (id, timestamp)))
            .collect::<HashMap<_, _>>(),
        _ => HashMap::new(),
    };
    prune_deleted_archived_task_ids(&mut ids, now_ms);
    Ok(ids)
}

fn timestamp_from_value(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
}

fn prune_deleted_archived_task_ids(ids: &mut HashMap<String, i64>, now_ms: i64) {
    ids.retain(|id, deleted_at| {
        !id.trim().is_empty()
            && *deleted_at > 0
            && now_ms.saturating_sub(*deleted_at) <= DELETED_ARCHIVED_TASK_ID_TTL_MS
    });
    if ids.len() <= DELETED_ARCHIVED_TASK_ID_MAX_COUNT {
        return;
    }

    let mut newest = ids
        .iter()
        .map(|(id, deleted_at)| (id.clone(), *deleted_at))
        .collect::<Vec<_>>();
    newest.sort_by_key(|(_, deleted_at)| Reverse(*deleted_at));
    newest.truncate(DELETED_ARCHIVED_TASK_ID_MAX_COUNT);
    *ids = newest.into_iter().collect();
}

fn temporary_index_path(index_path: &Path) -> PathBuf {
    let file_name = index_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("index.json");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    index_path.with_file_name(format!(
        ".{file_name}.{}.{}.{}.tmp",
        std::process::id(),
        nanos,
        sequence
    ))
}

fn atomic_write_file(index_path: &Path, payload: &[u8]) -> io::Result<()> {
    let parent = index_parent(index_path);
    fs::create_dir_all(parent)
        .map_err(|error| io_error_with_context("create index parent directory", parent, error))?;

    let temp_path = temporary_index_path(index_path);
    let mut temp_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|error| io_error_with_context("create temporary index", &temp_path, error))?;

    let write_result = temp_file
        .write_all(payload)
        .and_then(|_| temp_file.sync_all());
    drop(temp_file);
    if let Err(error) = write_result {
        return Err(clean_up_temp_file(
            &temp_path,
            io_error_with_context("write and sync temporary index", &temp_path, error),
        ));
    }

    if let Err(error) = replace_file(&temp_path, index_path) {
        return Err(clean_up_temp_file(
            &temp_path,
            io_error_with_context("replace runtime work index", index_path, error),
        ));
    }

    sync_parent_directory(parent)
        .map_err(|error| io_error_with_context("sync index parent directory", parent, error))
}

fn index_parent(index_path: &Path) -> &Path {
    index_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> io::Result<()> {
    Ok(())
}

fn clean_up_temp_file(temp_path: &Path, original_error: io::Error) -> io::Error {
    match fs::remove_file(temp_path) {
        Ok(()) => original_error,
        Err(cleanup_error) if cleanup_error.kind() == io::ErrorKind::NotFound => original_error,
        Err(cleanup_error) => io::Error::new(
            original_error.kind(),
            format!(
                "{original_error}; failed to clean up temporary index {}: {cleanup_error}",
                temp_path.display()
            ),
        ),
    }
}

fn io_error_with_context(action: &str, path: &Path, error: io::Error) -> io::Error {
    io::Error::new(
        error.kind(),
        format!("{action} {}: {error}", path.display()),
    )
}

fn default_index_path() -> PathBuf {
    runtime_work_dir().join("index.json")
}

pub(crate) fn runtime_work_dir() -> PathBuf {
    executor_home().join("runtime-work")
}

fn executor_home() -> PathBuf {
    env::var("WEGENT_EXECUTOR_HOME")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map(expand_home)
        .unwrap_or_else(|| expand_home("~/.wegent-executor"))
}

fn expand_home(value: impl AsRef<str>) -> PathBuf {
    let value = value.as_ref();
    if value == "~" {
        return home_dir();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    Path::new(value).to_path_buf()
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_existing_index() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let index_path = directory.path().join("index.json");
        fs::write(&index_path, b"old index").expect("old index should be written");

        atomic_write_file(&index_path, b"new index").expect("index replacement should succeed");

        assert_eq!(
            fs::read(&index_path).expect("replaced index should be readable"),
            b"new index"
        );
        assert!(temporary_files(directory.path()).is_empty());
    }

    #[test]
    fn atomic_write_cleans_up_temp_file_after_replace_failure() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let index_path = directory.path().join("index.json");
        fs::create_dir(&index_path).expect("conflicting index directory should be created");
        let sentinel_path = index_path.join("sentinel");
        fs::write(&sentinel_path, b"existing index").expect("sentinel should be written");

        let error = atomic_write_file(&index_path, b"new index")
            .expect_err("replacing a non-empty directory should fail");

        assert!(
            error.to_string().contains("replace runtime work index"),
            "unexpected error: {error}"
        );
        assert_eq!(
            fs::read(&sentinel_path).expect("existing index should remain intact"),
            b"existing index"
        );
        assert!(temporary_files(directory.path()).is_empty());
    }

    #[test]
    fn failed_store_write_does_not_update_index_signature() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let index_path = directory.path().join("index.json");
        fs::create_dir(&index_path).expect("conflicting index directory should be created");
        fs::write(index_path.join("sentinel"), b"existing index")
            .expect("sentinel should be written");
        let store = RuntimeWorkStore::new(index_path);
        let signature_before = *store
            .index_signature
            .lock()
            .expect("index signature lock should be available");

        store.upsert_task(RuntimeTaskLink::new_pending(
            "failed-task".to_owned(),
            "/tmp/failed".to_owned(),
            "Failed task".to_owned(),
        ));

        assert_eq!(
            *store
                .index_signature
                .lock()
                .expect("index signature lock should be available"),
            signature_before
        );
        assert!(temporary_files(directory.path()).is_empty());
    }

    fn temporary_files(directory: &Path) -> Vec<PathBuf> {
        fs::read_dir(directory)
            .expect("temporary directory should be readable")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(".index.json.") && name.ends_with(".tmp"))
            })
            .collect()
    }

    #[test]
    fn shared_index_reload_preserves_process_local_execution_state() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let index_path = directory.path().join("index.json");
        let owner_store = RuntimeWorkStore::new(index_path.clone());
        let peer_store = RuntimeWorkStore::new(index_path.clone());

        owner_store.upsert_task(RuntimeTaskLink::new_pending(
            "owner-task".to_owned(),
            "/tmp/owner".to_owned(),
            "Owner task".to_owned(),
        ));
        owner_store.update_task("owner-task", |task| {
            task.status = "running".to_owned();
            task.running = true;
            task.thread_status = "active".to_owned();
            task.turn_status = Some("inProgress".to_owned());
            task.runtime_handle["queuePosition"] = Value::from(2);
            task.runtime_handle["lastError"] = Value::from("temporary error");
            task.runtime_handle["lastErrorCode"] = Value::from("temporary_error");
        });
        peer_store.update_task("owner-task", |task| {
            task.title = "Updated owner task".to_owned();
            task.runtime_handle["modelSelection"] = serde_json::json!({"modelName": "gpt-5.6-sol"});
        });
        peer_store.upsert_task(RuntimeTaskLink::new_imported(
            "peer-task".to_owned(),
            "/tmp/peer".to_owned(),
            "Peer task".to_owned(),
            "codex".to_owned(),
            serde_json::json!({}),
            serde_json::json!({}),
        ));

        let owner_task = owner_store
            .get_task("owner-task")
            .expect("owner task should survive peer writes");
        assert_eq!(owner_task.title, "Updated owner task");
        assert!(owner_task.running);
        assert_eq!(owner_task.status, "running");
        assert_eq!(owner_task.thread_status, "active");
        assert_eq!(owner_task.turn_status.as_deref(), Some("inProgress"));
        assert_eq!(
            owner_task.runtime_handle["modelSelection"]["modelName"],
            Value::from("gpt-5.6-sol")
        );
        assert_eq!(owner_task.runtime_handle["queuePosition"], Value::from(2));
        assert_eq!(
            owner_task.runtime_handle["lastError"],
            Value::from("temporary error")
        );
        assert_eq!(
            owner_task.runtime_handle["lastErrorCode"],
            Value::from("temporary_error")
        );

        let persisted: Value = serde_json::from_slice(
            &fs::read(&index_path).expect("shared index should be readable"),
        )
        .expect("shared index should contain JSON");
        let persisted_owner = persisted["tasks"]["owner-task"]
            .as_object()
            .expect("owner task should be persisted");
        assert!(!persisted_owner.contains_key("running"));
        assert!(!persisted_owner.contains_key("status"));
        assert!(!persisted_owner.contains_key("thread_status"));
        assert!(!persisted_owner.contains_key("turn_status"));
        assert!(!persisted_owner.contains_key("completed_at"));
        assert_eq!(persisted_owner.get("archived"), Some(&Value::Bool(false)));
    }

    #[test]
    fn persisted_archive_metadata_restores_without_task_status_fields() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let index_path = directory.path().join("index.json");
        let store = RuntimeWorkStore::new(index_path.clone());
        let mut archived = RuntimeTaskLink::new_imported(
            "archived-task".to_owned(),
            "/tmp/archived".to_owned(),
            "Archived task".to_owned(),
            "codex".to_owned(),
            serde_json::json!({}),
            serde_json::json!({}),
        );
        archived.status = "archived".to_owned();

        store.upsert_task(archived);

        let restored = RuntimeWorkStore::new(index_path)
            .get_task("archived-task")
            .expect("archived task should be restored");
        assert_eq!(restored.status, "archived");
        assert!(!restored.running);
        assert_eq!(restored.thread_status, "notLoaded");
        assert_eq!(restored.turn_status, None);
    }

    #[test]
    fn persisted_project_context_restores_with_task_metadata() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let index_path = directory.path().join("index.json");
        let store = RuntimeWorkStore::new(index_path.clone());
        let mut task = RuntimeTaskLink::new_pending(
            "project-context-task".to_owned(),
            "/tmp/project-context".to_owned(),
            "Project context".to_owned(),
        );
        task.project_instructions = "Follow the project instructions".to_owned();
        task.project_plugin_ids = vec!["plugin-a".to_owned(), "plugin-b".to_owned()];

        store.upsert_task(task);

        let restored = RuntimeWorkStore::new(index_path)
            .get_task("project-context-task")
            .expect("project context task should be restored");
        assert_eq!(
            restored.project_instructions,
            "Follow the project instructions"
        );
        assert_eq!(
            restored.project_plugin_ids,
            vec!["plugin-a".to_owned(), "plugin-b".to_owned()]
        );
    }

    #[test]
    fn terminal_turn_status_is_not_persisted() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let index_path = directory.path().join("index.json");
        let store = RuntimeWorkStore::new(index_path.clone());
        let mut completed = RuntimeTaskLink::new_imported(
            "completed-task".to_owned(),
            "/tmp/completed".to_owned(),
            "Completed task".to_owned(),
            "codex".to_owned(),
            serde_json::json!({}),
            serde_json::json!({}),
        );
        completed.status = "done".to_owned();
        completed.turn_status = Some("completed".to_owned());
        completed.completed_at = Some(1_780_000_000_000);
        completed.runtime_handle = serde_json::json!({
            "queuePosition": 1,
            "lastError": "transient",
            "lastErrorCode": "transient_error",
            "messages": [{"id": "cached-message"}],
            "completedTranscriptMessages": [{"id": "completed-message"}],
            "completedTranscriptThreadId": "thread-1",
            "transcriptSnapshotMessages": [{"id": "snapshot-message"}],
            "transcriptSnapshotThreadId": "thread-1",
            "modelSelection": {"modelName": "gpt-5.6-sol"},
            "wegentTeam": {
                "id": 7,
                "agent_config": {"api_key": "must-not-persist"}
            },
            "teamExecutionProfile": {"agent_config": {"api_key": "must-not-persist"}}
        });

        store.upsert_task(completed);

        let persisted: Value =
            serde_json::from_slice(&fs::read(&index_path).expect("index should be readable"))
                .expect("index should contain JSON");
        let task = persisted["tasks"]["completed-task"]
            .as_object()
            .expect("completed task should be persisted");
        assert!(!task.contains_key("status"));
        assert!(!task.contains_key("running"));
        assert!(!task.contains_key("thread_status"));
        assert!(!task.contains_key("turn_status"));
        assert!(!task.contains_key("completed_at"));
        assert!(task["runtime_handle"].get("queuePosition").is_none());
        assert!(task["runtime_handle"].get("lastError").is_none());
        assert!(task["runtime_handle"].get("lastErrorCode").is_none());
        assert!(task["runtime_handle"].get("messages").is_none());
        assert!(task["runtime_handle"]
            .get("completedTranscriptMessages")
            .is_none());
        assert!(task["runtime_handle"]
            .get("completedTranscriptThreadId")
            .is_none());
        assert!(task["runtime_handle"]
            .get("transcriptSnapshotMessages")
            .is_none());
        assert!(task["runtime_handle"]
            .get("transcriptSnapshotThreadId")
            .is_none());
        assert_eq!(
            task["runtime_handle"]["modelSelection"]["modelName"],
            "gpt-5.6-sol"
        );
        assert_eq!(task["runtime_handle"]["wegentTeam"]["id"], 7);
        assert!(task["runtime_handle"]["wegentTeam"]
            .get("agent_config")
            .is_none());
        assert!(task["runtime_handle"].get("teamExecutionProfile").is_none());

        let restored = RuntimeWorkStore::new(index_path)
            .get_task("completed-task")
            .expect("completed task should be restored");
        assert!(!restored.running);
        assert_eq!(restored.status, "active");
        assert_eq!(restored.thread_status, "notLoaded");
        assert_eq!(restored.turn_status, None);
        assert_eq!(restored.completed_at, None);
        assert!(restored.runtime_handle.get("queuePosition").is_none());
        assert!(restored.runtime_handle.get("lastError").is_none());
    }

    #[test]
    fn startup_migrates_legacy_runtime_handle_payloads() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let index_path = directory.path().join("index.json");
        fs::write(
            &index_path,
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "tasks": {
                    "legacy-task": {
                        "local_task_id": "legacy-task",
                        "runtime_handle": {
                            "modelSelection": {"modelName": "gpt-5.6-sol"},
                            "messages": [{"id": "cached-message"}],
                            "completedTranscriptMessages": [{"id": "completed-message"}],
                            "transcriptSnapshotMessages": [{"id": "snapshot-message"}]
                        }
                    }
                },
                "workspaces": {}
            }))
            .expect("legacy index should serialize"),
        )
        .expect("legacy index should be written");

        let store = RuntimeWorkStore::new(index_path.clone());

        let restored = store
            .get_task("legacy-task")
            .expect("legacy task should be restored");
        assert_eq!(
            restored.runtime_handle["modelSelection"]["modelName"],
            "gpt-5.6-sol"
        );
        assert!(restored.runtime_handle.get("messages").is_none());
        assert!(restored
            .runtime_handle
            .get("completedTranscriptMessages")
            .is_none());
        assert!(restored
            .runtime_handle
            .get("transcriptSnapshotMessages")
            .is_none());

        let migrated: Value =
            serde_json::from_slice(&fs::read(index_path).expect("index should be readable"))
                .expect("index should contain JSON");
        let runtime_handle = &migrated["tasks"]["legacy-task"]["runtime_handle"];
        assert_eq!(runtime_handle["modelSelection"]["modelName"], "gpt-5.6-sol");
        assert!(runtime_handle.get("messages").is_none());
        assert!(runtime_handle.get("completedTranscriptMessages").is_none());
        assert!(runtime_handle.get("transcriptSnapshotMessages").is_none());
    }

    #[test]
    fn transient_runtime_updates_do_not_rewrite_the_index() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let index_path = directory.path().join("index.json");
        let store = RuntimeWorkStore::new(index_path);
        store.upsert_task(RuntimeTaskLink::new_pending(
            "runtime-task".to_owned(),
            "/tmp/runtime-task".to_owned(),
            "Runtime task".to_owned(),
        ));
        let writes_after_create = store.write_attempts.load(Ordering::Relaxed);

        store.update_task("runtime-task", |task| {
            task.status = "running".to_owned();
            task.running = true;
            task.updated_at += 1;
            task.runtime_handle["messages"] = serde_json::json!([{"id": "streaming-message"}]);
            task.runtime_handle["transcriptSnapshotMessages"] =
                serde_json::json!([{"id": "snapshot-message"}]);
        });

        assert_eq!(
            store.write_attempts.load(Ordering::Relaxed),
            writes_after_create
        );

        store.update_task("runtime-task", |task| {
            task.runtime_handle["modelSelection"] = serde_json::json!({"modelName": "gpt-5.6-sol"});
        });
        assert_eq!(
            store.write_attempts.load(Ordering::Relaxed),
            writes_after_create + 1
        );
    }

    #[test]
    fn legacy_archived_status_is_migrated_at_the_deserialization_boundary() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let index_path = directory.path().join("index.json");
        fs::write(
            &index_path,
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "tasks": {
                    "legacy-task": {
                        "local_task_id": "legacy-task",
                        "status": "archived"
                    }
                },
                "workspaces": {}
            }))
            .expect("legacy index should serialize"),
        )
        .expect("legacy index should be written");

        let store = RuntimeWorkStore::new(index_path.clone());
        let restored = store
            .get_task("legacy-task")
            .expect("legacy archived task should be restored");
        assert_eq!(restored.status, "archived");

        store.update_task("legacy-task", |_| {});
        let persisted: Value =
            serde_json::from_slice(&fs::read(index_path).expect("index should be readable"))
                .expect("index should contain JSON");
        let task = persisted["tasks"]["legacy-task"]
            .as_object()
            .expect("legacy task should be rewritten as metadata");
        assert_eq!(task.get("archived"), Some(&Value::Bool(true)));
        assert!(!task.contains_key("status"));
    }
}
