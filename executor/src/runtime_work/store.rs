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
    throttled_writes: Arc<Mutex<HashMap<String, i64>>>,
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

impl RuntimeWorkStore {
    pub fn new(index_path: PathBuf) -> Self {
        let index = read_index_from_path(&index_path);
        Self {
            index_path,
            index: Arc::new(Mutex::new(index)),
            throttled_writes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn from_env() -> Self {
        Self::new(default_index_path())
    }

    pub fn list_tasks(&self, include_archived: bool) -> Vec<RuntimeTaskLink> {
        let mut tasks = self
            .read_index_snapshot()
            .tasks
            .into_values()
            .filter(|task| include_archived || task.status != "archived")
            .collect::<Vec<_>>();
        tasks.sort_by_key(|task| Reverse(task.updated_at));
        tasks
    }

    pub fn get_task(&self, local_task_id: &str) -> Option<RuntimeTaskLink> {
        self.read_index_snapshot().tasks.get(local_task_id).cloned()
    }

    pub fn find_by_thread_id(&self, thread_id: &str) -> Option<RuntimeTaskLink> {
        self.read_index_snapshot()
            .tasks
            .into_values()
            .find(|link| link.thread_id.as_deref() == Some(thread_id))
    }

    pub fn is_deleted_archived_task_id(&self, task_id: &str) -> bool {
        self.read_index_snapshot()
            .deleted_archived_task_ids
            .contains_key(task_id)
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

    pub fn update_task_throttled(
        &self,
        local_task_id: &str,
        min_interval_ms: i64,
        updater: impl FnOnce(&mut RuntimeTaskLink),
    ) -> Option<RuntimeTaskLink> {
        let mut index = self.index.lock().ok()?;
        let task = index.tasks.get_mut(local_task_id)?;
        updater(task);
        let updated = task.clone();
        if self.throttled_write_due(local_task_id, min_interval_ms) {
            self.write_index(&index);
        }
        Some(updated)
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
        if let Ok(mut throttled_writes) = self.throttled_writes.lock() {
            throttled_writes.remove(local_task_id);
        }
        self.write_index(&index);
        Some(removed)
    }

    fn throttled_write_due(&self, local_task_id: &str, min_interval_ms: i64) -> bool {
        let now_ms = current_time_ms();
        let Ok(mut throttled_writes) = self.throttled_writes.lock() else {
            return true;
        };
        let last_write_ms = throttled_writes
            .get(local_task_id)
            .copied()
            .unwrap_or_default();
        if now_ms - last_write_ms < min_interval_ms {
            return false;
        }
        throttled_writes.insert(local_task_id.to_owned(), now_ms);
        true
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
            if fs::write(&temp_path, payload).is_ok()
                && fs::rename(&temp_path, &self.index_path).is_err()
            {
                let _ = fs::remove_file(temp_path);
            }
        }
    }

    fn read_index_snapshot(&self) -> RuntimeWorkIndex {
        let mut disk_index = read_index_from_path(&self.index_path);
        let before_deleted_count = disk_index.deleted_archived_task_ids.len();
        prune_deleted_archived_task_ids(
            &mut disk_index.deleted_archived_task_ids,
            current_time_ms(),
        );
        let dirty_task_ids = self
            .throttled_writes
            .lock()
            .ok()
            .map(|writes| writes.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let Some(mut memory_index) = self.index.lock().ok() else {
            return disk_index;
        };
        for task_id in dirty_task_ids {
            if let Some(link) = memory_index.tasks.get(&task_id) {
                disk_index.tasks.insert(task_id, link.clone());
            }
        }
        *memory_index = disk_index.clone();
        if disk_index.deleted_archived_task_ids.len() != before_deleted_count {
            self.write_index(&disk_index);
        }
        disk_index
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
    env::var("HOME")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_task_throttled_persists_at_interval() {
        let index_path = temp_index_path("throttled-delta");
        let store = RuntimeWorkStore::new(index_path.clone());
        store.upsert_task(RuntimeTaskLink::new_pending(
            "task-1".to_owned(),
            "/tmp/workspace".to_owned(),
            "Task".to_owned(),
        ));

        store.update_task_throttled("task-1", 60_000, |link| {
            link.title = "First delta".to_owned();
        });
        let reloaded_after_first_write = RuntimeWorkStore::new(index_path.clone());
        assert_eq!(
            reloaded_after_first_write.get_task("task-1").unwrap().title,
            "First delta"
        );

        store.update_task_throttled("task-1", 60_000, |link| {
            link.title = "Second delta".to_owned();
        });
        assert_eq!(store.get_task("task-1").unwrap().title, "Second delta");
        let reloaded_before_next_due = RuntimeWorkStore::new(index_path.clone());
        assert_eq!(
            reloaded_before_next_due.get_task("task-1").unwrap().title,
            "First delta"
        );

        store.update_task("task-1", |link| {
            link.status = "done".to_owned();
        });
        let reloaded_after_terminal_write = RuntimeWorkStore::new(index_path.clone());
        let task = reloaded_after_terminal_write.get_task("task-1").unwrap();
        assert_eq!(task.title, "Second delta");
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
