// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    cmp::Reverse,
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::response::{RuntimeTaskLink, RuntimeWorkspaceLink};

const INDEX_VERSION: u64 = 1;
const DELETED_ARCHIVED_TASK_ID_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
const DELETED_ARCHIVED_TASK_ID_MAX_COUNT: usize = 2_000;

#[derive(Clone)]
pub(crate) struct RuntimeWorkStore {
    index_path: PathBuf,
    index: Arc<Mutex<RuntimeWorkIndex>>,
    index_signature: Arc<Mutex<Option<IndexFileSignature>>>,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct IndexFileSignature {
    len: u64,
    modified_ms: u128,
}

impl RuntimeWorkStore {
    pub fn new(index_path: PathBuf) -> Self {
        let index = read_index_from_path(&index_path);
        let index_signature = index_file_signature(&index_path);
        Self {
            index_path,
            index: Arc::new(Mutex::new(index)),
            index_signature: Arc::new(Mutex::new(index_signature)),
        }
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
        if index.deleted_archived_task_ids.len() != before_deleted_count {
            self.write_index(&index);
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
        self.write_index(&index);
    }

    pub fn upsert_task(&self, link: RuntimeTaskLink) {
        self.refresh_index_from_disk_if_changed();
        let Some(mut index) = self.index.lock().ok() else {
            return;
        };
        index.tasks.insert(link.local_task_id.clone(), link);
        self.write_index(&index);
    }

    pub fn update_task(
        &self,
        local_task_id: &str,
        updater: impl FnOnce(&mut RuntimeTaskLink),
    ) -> Option<RuntimeTaskLink> {
        self.update_task_with_persistence(local_task_id, updater, true)
    }

    pub fn update_task_execution_state(&self, runtime_state: &RuntimeTaskLink) {
        self.update_task_with_persistence(
            &runtime_state.local_task_id,
            |task| task.copy_execution_state_from(runtime_state),
            false,
        );
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
        updater(task);
        let updated = task.clone();
        if persist {
            self.write_index(&index);
        }
        Some(updated)
    }

    pub fn delete_task(&self, local_task_id: &str) -> Option<RuntimeTaskLink> {
        self.refresh_index_from_disk_if_changed();
        let mut index = self.index.lock().ok()?;
        let removed = index.tasks.remove(local_task_id)?;
        self.write_index(&index);
        Some(removed)
    }

    fn write_index(&self, index: &RuntimeWorkIndex) {
        if let Some(parent) = self.index_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let now_ms = current_time_ms();
        let mut deleted_archived_task_ids = index.deleted_archived_task_ids.clone();
        prune_deleted_archived_task_ids(&mut deleted_archived_task_ids, now_ms);
        let payload = serialize_index(&RuntimeWorkIndex {
            version: INDEX_VERSION,
            tasks: index.tasks.clone(),
            workspaces: index.workspaces.clone(),
            deleted_archived_task_ids,
        });
        if let Ok(payload) = payload {
            let temp_path = temporary_index_path(&self.index_path);
            if fs::write(&temp_path, payload).is_ok() {
                if fs::rename(&temp_path, &self.index_path).is_ok() {
                    self.update_index_signature();
                } else {
                    let _ = fs::remove_file(temp_path);
                }
            }
        }
    }

    fn refresh_index_from_disk_if_changed(&self) {
        let current_signature = index_file_signature(&self.index_path);
        let changed = self
            .index_signature
            .lock()
            .ok()
            .is_some_and(|signature| *signature != current_signature);
        if !changed {
            return;
        }

        let mut disk_index = read_index_from_path(&self.index_path);
        if let Ok(mut index) = self.index.lock() {
            for (task_id, disk_task) in &mut disk_index.tasks {
                if let Some(current_task) = index.tasks.get(task_id) {
                    disk_task.preserve_runtime_state_from(current_task);
                }
            }
            *index = disk_index;
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

fn read_index_from_path(index_path: &Path) -> RuntimeWorkIndex {
    let Ok(content) = fs::read_to_string(index_path) else {
        return empty_index();
    };
    let Ok(mut value) = serde_json::from_str::<Value>(&content) else {
        return empty_index();
    };
    restore_persisted_task_metadata(&mut value);
    serde_json::from_value::<RuntimeWorkIndex>(value).unwrap_or_else(|_| empty_index())
}

fn serialize_index(index: &RuntimeWorkIndex) -> Result<Vec<u8>, serde_json::Error> {
    let mut value = serde_json::to_value(index)?;
    strip_transient_task_state(&mut value);
    serde_json::to_vec(&value)
}

fn strip_transient_task_state(index: &mut Value) {
    for task in index
        .get_mut("tasks")
        .and_then(Value::as_object_mut)
        .into_iter()
        .flat_map(|tasks| tasks.values_mut())
    {
        let Some(task) = task.as_object_mut() else {
            continue;
        };
        let archived = task
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| status.eq_ignore_ascii_case("archived"));
        task.remove("status");
        task.remove("running");
        task.remove("thread_status");
        if !task
            .get("turn_status")
            .and_then(Value::as_str)
            .is_some_and(is_terminal_turn_status)
        {
            task.remove("turn_status");
        }
        task.insert("archived".to_owned(), Value::Bool(archived));
    }
}

fn restore_persisted_task_metadata(index: &mut Value) {
    for task in index
        .get_mut("tasks")
        .and_then(Value::as_object_mut)
        .into_iter()
        .flat_map(|tasks| tasks.values_mut())
    {
        let Some(task) = task.as_object_mut() else {
            continue;
        };
        let legacy_status = task
            .remove("status")
            .and_then(|value| value.as_str().map(str::to_owned));
        let archived = task
            .remove("archived")
            .and_then(|value| value.as_bool())
            .unwrap_or_else(|| {
                legacy_status
                    .as_deref()
                    .is_some_and(|status| status.eq_ignore_ascii_case("archived"))
            });
        let restored_status = legacy_status
            .filter(|status| {
                matches!(
                    status.trim().to_ascii_lowercase().as_str(),
                    "done" | "cancelled" | "canceled" | "failed"
                )
            })
            .unwrap_or_else(|| "active".to_owned());
        task.insert(
            "status".to_owned(),
            Value::String(if archived {
                "archived".to_owned()
            } else {
                restored_status
            }),
        );
        task.remove("running");
        task.remove("thread_status");
        if !task
            .get("turn_status")
            .and_then(Value::as_str)
            .is_some_and(is_terminal_turn_status)
        {
            task.remove("turn_status");
        }
    }
}

fn is_terminal_turn_status(status: &str) -> bool {
    matches!(
        status.replace(['_', '-'], "").to_ascii_lowercase().as_str(),
        "completed" | "done" | "failed" | "error" | "interrupted" | "cancelled" | "canceled"
    )
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

fn empty_index() -> RuntimeWorkIndex {
    RuntimeWorkIndex {
        version: INDEX_VERSION,
        tasks: HashMap::new(),
        workspaces: HashMap::new(),
        deleted_archived_task_ids: HashMap::new(),
    }
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
    index_path.with_file_name(format!(".{file_name}.{}.{}.tmp", std::process::id(), nanos))
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
    fn shared_index_reload_preserves_process_local_running_state() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let index_path = directory.path().join("index.json");
        let owner_store = RuntimeWorkStore::new(index_path.clone());
        let peer_store = RuntimeWorkStore::new(index_path.clone());

        owner_store.upsert_task(RuntimeTaskLink::new_pending(
            "owner-task".to_owned(),
            "/tmp/owner".to_owned(),
            "Owner task".to_owned(),
        ));
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
        assert!(owner_task.running);
        assert_eq!(owner_task.status, "running");
        assert_eq!(owner_task.thread_status, "active");
        assert_eq!(owner_task.turn_status.as_deref(), Some("inProgress"));

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
        assert_eq!(persisted_owner.get("archived"), Some(&Value::Bool(false)));
    }

    #[test]
    fn shared_index_reload_preserves_process_local_inactive_execution_state() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let index_path = directory.path().join("index.json");
        let owner_store = RuntimeWorkStore::new(index_path.clone());
        let peer_store = RuntimeWorkStore::new(index_path);
        let mut owner_task = RuntimeTaskLink::new_pending(
            "owner-task".to_owned(),
            "/tmp/owner".to_owned(),
            "Owner task".to_owned(),
        );

        owner_store.upsert_task(owner_task.clone());
        owner_task.status = "done".to_owned();
        owner_task.running = false;
        owner_task.thread_status = "idle".to_owned();
        owner_task.turn_status = Some("completed".to_owned());
        owner_store.update_task_execution_state(&owner_task);
        peer_store.upsert_task(RuntimeTaskLink::new_imported(
            "peer-task".to_owned(),
            "/tmp/peer".to_owned(),
            "Peer task".to_owned(),
            "codex".to_owned(),
            serde_json::json!({}),
            serde_json::json!({}),
        ));

        let reloaded = owner_store
            .get_task("owner-task")
            .expect("owner task should survive peer writes");
        assert_eq!(reloaded.status, "done");
        assert!(!reloaded.running);
        assert_eq!(reloaded.thread_status, "idle");
        assert_eq!(reloaded.turn_status.as_deref(), Some("completed"));
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
    fn terminal_turn_status_persists_without_live_execution_state() {
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
        assert_eq!(
            task.get("turn_status"),
            Some(&Value::String("completed".to_owned()))
        );

        let restored = RuntimeWorkStore::new(index_path)
            .get_task("completed-task")
            .expect("completed task should be restored");
        assert!(!restored.running);
        assert_eq!(restored.status, "active");
        assert_eq!(restored.thread_status, "notLoaded");
        assert_eq!(restored.turn_status.as_deref(), Some("completed"));
    }

    #[test]
    fn legacy_archived_status_migrates_to_archive_metadata() {
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

        let restored = RuntimeWorkStore::new(index_path)
            .get_task("legacy-task")
            .expect("legacy archived task should be restored");
        assert_eq!(restored.status, "archived");
    }
}
