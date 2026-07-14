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

    pub fn update_task_in_memory(
        &self,
        local_task_id: &str,
        updater: impl FnOnce(&mut RuntimeTaskLink),
    ) -> Option<RuntimeTaskLink> {
        self.update_task_with_persistence(local_task_id, updater, false)
    }

    fn update_task_with_persistence(
        &self,
        local_task_id: &str,
        updater: impl FnOnce(&mut RuntimeTaskLink),
        persist: bool,
    ) -> Option<RuntimeTaskLink> {
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
        let payload = serde_json::to_vec(&RuntimeWorkIndex {
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

        let disk_index = read_index_from_path(&self.index_path);
        if let Ok(mut index) = self.index.lock() {
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
    serde_json::from_str::<RuntimeWorkIndex>(&content).unwrap_or_else(|_| empty_index())
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
    fn update_task_in_memory_defers_persistence_until_next_write() {
        let index_path = temp_index_path("in-memory-update");
        let store = RuntimeWorkStore::new(index_path.clone());
        store.upsert_task(RuntimeTaskLink::new_pending(
            "task-1".to_owned(),
            "/tmp/workspace".to_owned(),
            "Task".to_owned(),
        ));

        store.update_task_in_memory("task-1", |link| {
            link.title = "Streaming delta".to_owned();
        });
        assert_eq!(store.get_task("task-1").unwrap().title, "Streaming delta");
        let reloaded_before_persist = RuntimeWorkStore::new(index_path.clone());
        assert_eq!(
            reloaded_before_persist.get_task("task-1").unwrap().title,
            "Task"
        );

        store.update_task("task-1", |link| {
            link.status = "done".to_owned();
        });
        let reloaded_after_persist = RuntimeWorkStore::new(index_path.clone());
        let task = reloaded_after_persist.get_task("task-1").unwrap();
        assert_eq!(task.title, "Streaming delta");
        assert_eq!(task.status, "done");

        let _ = fs::remove_file(index_path);
    }

    fn temp_index_path(label: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "wegent-runtime-work-store-{label}-{}-{}.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ))
    }
}
