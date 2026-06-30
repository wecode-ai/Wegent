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

use serde::{Deserialize, Serialize};

use super::response::{RuntimeTaskLink, RuntimeWorkspaceLink};

const INDEX_VERSION: u64 = 1;

#[derive(Clone)]
pub(crate) struct RuntimeWorkStore {
    index_path: PathBuf,
    lock: Arc<Mutex<()>>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct RuntimeWorkIndex {
    version: u64,
    tasks: HashMap<String, RuntimeTaskLink>,
    workspaces: HashMap<String, RuntimeWorkspaceLink>,
}

impl RuntimeWorkStore {
    pub fn new(index_path: PathBuf) -> Self {
        Self {
            index_path,
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn from_env() -> Self {
        Self::new(default_index_path())
    }

    pub fn list_tasks(&self, include_archived: bool) -> Vec<RuntimeTaskLink> {
        let _guard = self.lock.lock().ok();
        let mut tasks = self
            .read_index()
            .tasks
            .into_values()
            .filter(|task| include_archived || task.status != "archived")
            .collect::<Vec<_>>();
        tasks.sort_by_key(|task| Reverse(task.updated_at));
        tasks
    }

    pub fn get_task(&self, local_task_id: &str) -> Option<RuntimeTaskLink> {
        let _guard = self.lock.lock().ok();
        self.read_index().tasks.get(local_task_id).cloned()
    }

    pub fn find_by_thread_id(&self, thread_id: &str) -> Option<RuntimeTaskLink> {
        let _guard = self.lock.lock().ok();
        self.read_index()
            .tasks
            .into_values()
            .find(|link| link.thread_id.as_deref() == Some(thread_id))
    }

    pub fn upsert_task(&self, link: RuntimeTaskLink) {
        let _guard = self.lock.lock().ok();
        let mut index = self.read_index();
        index.tasks.insert(link.local_task_id.clone(), link);
        self.write_index(&index);
    }

    pub fn update_task(
        &self,
        local_task_id: &str,
        updater: impl FnOnce(&mut RuntimeTaskLink),
    ) -> Option<RuntimeTaskLink> {
        let _guard = self.lock.lock().ok();
        let mut index = self.read_index();
        let task = index.tasks.get_mut(local_task_id)?;
        updater(task);
        let updated = task.clone();
        self.write_index(&index);
        Some(updated)
    }

    pub fn delete_task(&self, local_task_id: &str) -> Option<RuntimeTaskLink> {
        let _guard = self.lock.lock().ok();
        let mut index = self.read_index();
        let removed = index.tasks.remove(local_task_id)?;
        self.write_index(&index);
        Some(removed)
    }

    fn read_index(&self) -> RuntimeWorkIndex {
        let Ok(content) = fs::read_to_string(&self.index_path) else {
            return RuntimeWorkIndex {
                version: INDEX_VERSION,
                tasks: HashMap::new(),
                workspaces: HashMap::new(),
            };
        };
        serde_json::from_str::<RuntimeWorkIndex>(&content).unwrap_or_else(|_| RuntimeWorkIndex {
            version: INDEX_VERSION,
            tasks: HashMap::new(),
            workspaces: HashMap::new(),
        })
    }

    fn write_index(&self, index: &RuntimeWorkIndex) {
        if let Some(parent) = self.index_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let payload = serde_json::to_vec_pretty(&RuntimeWorkIndex {
            version: INDEX_VERSION,
            tasks: index.tasks.clone(),
            workspaces: index.workspaces.clone(),
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
