// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock, RwLock,
    },
    thread,
    time::{Duration, SystemTime},
};

#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{
    store::runtime_work_dir,
    util::{normalize_workspace_path, now_ms, path_is_within, workspace_label},
};

const CODEX_GLOBAL_STATE_FILENAME: &str = ".codex-global-state.json";
const CODEX_GLOBAL_STATE_OPLOG_FILENAME: &str = ".codex-global-state.oplog.jsonl";
const CODEX_GLOBAL_STATE_OPLOG_VERSION: u64 = 1;
const SAVED_WORKSPACE_ROOTS_KEY: &str = "electron-saved-workspace-roots";
const WORKSPACE_ROOT_LABELS_KEY: &str = "electron-workspace-root-labels";
const PROJECT_ORDER_KEY: &str = "project-order";
const ACTIVE_WORKSPACE_ROOTS_KEY: &str = "active-workspace-roots";
const PINNED_PROJECT_IDS_KEY: &str = "pinned-project-ids";
const REMOTE_PROJECTS_KEY: &str = "remote-projects";
const PROJECTLESS_THREAD_IDS_KEY: &str = "projectless-thread-ids";
const THREAD_WORKSPACE_ROOT_HINTS_KEY: &str = "thread-workspace-root-hints";
const OPLOG_KIND_UPSERT: &str = "upsert";
const OPLOG_KIND_RENAME: &str = "rename";
const OPLOG_KIND_REMOVE: &str = "remove";
const OPLOG_FLUSH_POLL_INTERVAL: Duration = Duration::from_secs(3);

static CODEX_GLOBAL_STATE_OPLOG_FLUSH_WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexGlobalProject {
    pub key: String,
    pub workspace_path: String,
    pub name: String,
    pub source: String,
    pub remote_host_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct CodexGlobalProjectIndex {
    projects: Vec<CodexGlobalProject>,
    projects_by_key: HashMap<String, usize>,
    projectless_thread_ids: HashSet<String>,
    thread_workspace_root_hints: HashMap<String, String>,
    project_state_loaded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexGlobalProjectSourceSignature {
    state_path: PathBuf,
    state_modified: Option<SystemTime>,
    state_len: Option<u64>,
    oplog_path: PathBuf,
    oplog_modified: Option<SystemTime>,
    oplog_len: Option<u64>,
}

#[derive(Clone, Default)]
struct CodexGlobalProjectCache {
    signature: Option<CodexGlobalProjectSourceSignature>,
    index: CodexGlobalProjectIndex,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
struct CodexGlobalStateOplogRecord {
    version: u64,
    kind: String,
    #[serde(rename = "workspacePath")]
    workspace_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: i64,
}

impl Default for CodexGlobalStateOplogRecord {
    fn default() -> Self {
        Self {
            version: CODEX_GLOBAL_STATE_OPLOG_VERSION,
            kind: String::new(),
            workspace_path: String::new(),
            label: None,
            updated_at: 0,
        }
    }
}

impl CodexGlobalProjectIndex {
    pub fn load() -> Self {
        flush_or_watch_codex_global_state_oplog();
        cached_codex_global_project_index()
    }

    pub fn projects(&self) -> &[CodexGlobalProject] {
        &self.projects
    }

    pub fn has_projects(&self) -> bool {
        !self.projects.is_empty()
    }

    pub fn has_project_state(&self) -> bool {
        self.project_state_loaded
    }

    pub fn is_projectless_thread(&self, thread_id: &str) -> bool {
        self.projectless_thread_ids.contains(thread_id)
    }

    pub fn thread_workspace_hint(&self, thread_id: &str) -> Option<&str> {
        self.thread_workspace_root_hints
            .get(thread_id)
            .map(String::as_str)
    }

    pub fn project_for_path(&self, workspace_path: &str) -> Option<&CodexGlobalProject> {
        let normalized = normalize_workspace_path(workspace_path);
        self.projects
            .iter()
            .filter(|project| path_is_within(&project.workspace_path, &normalized))
            .max_by_key(|project| project.workspace_path.len())
    }

    pub fn project_for_thread(
        &self,
        thread_id: Option<&str>,
        workspace_path: &str,
    ) -> Option<&CodexGlobalProject> {
        if let Some(thread_id) = thread_id {
            if self.projectless_thread_ids.contains(thread_id) {
                return None;
            }
            if let Some(hinted_root) = self.thread_workspace_root_hints.get(thread_id) {
                if let Some(project) = self.project_by_key_or_path(hinted_root) {
                    return Some(project);
                }
            }
        }
        self.project_for_path(workspace_path)
    }

    pub fn project_for_key(&self, value: &str) -> Option<&CodexGlobalProject> {
        self.project_by_key_or_path(value)
    }

    fn project_by_key_or_path(&self, value: &str) -> Option<&CodexGlobalProject> {
        let normalized = normalize_path_or_raw(value);
        self.projects_by_key
            .get(&normalized)
            .and_then(|index| self.projects.get(*index))
            .or_else(|| self.project_for_path(&normalized))
    }
}

pub(crate) fn open_codex_global_project(
    workspace_path: &str,
    label: Option<&str>,
) -> Result<CodexGlobalProject, String> {
    let normalized_workspace = normalize_workspace_path(workspace_path);
    record_codex_global_state_op(OPLOG_KIND_UPSERT, &normalized_workspace, label)?;
    Ok(local_project_from_label(&normalized_workspace, label))
}

pub(crate) fn register_codex_global_thread_workspace_root(
    thread_id: &str,
    workspace_path: &str,
) -> Result<Option<String>, String> {
    let thread_id = thread_id.trim();
    if thread_id.is_empty() {
        return Ok(None);
    }
    let normalized_workspace = normalize_workspace_path(workspace_path);
    if normalized_workspace.is_empty() {
        return Ok(None);
    }

    let state_path = codex_global_state_path();
    let mut payload = read_state_payload(&state_path).unwrap_or_default();
    let workspace_root = index_from_payload(&payload)
        .project_for_path(&normalized_workspace)
        .map(|project| project.workspace_path.clone())
        .unwrap_or(normalized_workspace);

    let mut hints = payload
        .get(THREAD_WORKSPACE_ROOT_HINTS_KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let existing_hint_matches = hints
        .get(thread_id)
        .and_then(Value::as_str)
        .map(normalize_workspace_path)
        .is_some_and(|hint| hint == workspace_root);
    let projectless_ids = text_list(payload.get(PROJECTLESS_THREAD_IDS_KEY));
    let was_projectless = projectless_ids.iter().any(|value| value == thread_id);
    if existing_hint_matches && !was_projectless {
        return Ok(None);
    }

    hints.insert(thread_id.to_owned(), Value::String(workspace_root.clone()));
    payload.insert(
        THREAD_WORKSPACE_ROOT_HINTS_KEY.to_owned(),
        Value::Object(hints),
    );
    if payload.contains_key(PROJECTLESS_THREAD_IDS_KEY) {
        remove_text_list_item(&mut payload, PROJECTLESS_THREAD_IDS_KEY, thread_id);
    }
    write_state_payload(&state_path, &payload)?;
    Ok(Some(workspace_root))
}

pub(crate) fn rename_codex_global_project(
    workspace_path: &str,
    label: &str,
) -> Result<CodexGlobalProject, String> {
    let normalized_label = label.trim();
    if normalized_label.is_empty() {
        return Err("label is required".to_owned());
    }
    let normalized_workspace = normalize_workspace_path(workspace_path);
    record_codex_global_state_op(
        OPLOG_KIND_RENAME,
        &normalized_workspace,
        Some(normalized_label),
    )?;
    Ok(local_project_from_label(
        &normalized_workspace,
        Some(normalized_label),
    ))
}

pub(crate) fn remove_codex_global_project(workspace_path: &str) -> Result<String, String> {
    let normalized_workspace = normalize_workspace_path(workspace_path);
    record_codex_global_state_op(OPLOG_KIND_REMOVE, &normalized_workspace, None)?;
    Ok(normalized_workspace)
}

fn record_codex_global_state_op(
    kind: &str,
    workspace_path: &str,
    label: Option<&str>,
) -> Result<(), String> {
    let _record = append_codex_global_state_op(kind, workspace_path, label)?;
    flush_or_watch_codex_global_state_oplog();
    refresh_codex_global_project_cache();
    Ok(())
}

fn append_codex_global_state_op(
    kind: &str,
    workspace_path: &str,
    label: Option<&str>,
) -> Result<CodexGlobalStateOplogRecord, String> {
    let normalized_workspace = normalize_workspace_path(workspace_path);
    if normalized_workspace.is_empty() {
        return Err("workspacePath is required".to_owned());
    }
    let record = CodexGlobalStateOplogRecord {
        version: CODEX_GLOBAL_STATE_OPLOG_VERSION,
        kind: kind.to_owned(),
        workspace_path: normalized_workspace,
        label: label
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        updated_at: now_ms(),
    };
    append_codex_global_state_op_record(&record)?;
    Ok(record)
}

fn append_codex_global_state_op_record(record: &CodexGlobalStateOplogRecord) -> Result<(), String> {
    let path = codex_global_state_oplog_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create Codex state oplog directory: {error}"))?;
    }
    let line = serde_json::to_string(&record)
        .map_err(|error| format!("failed to serialize Codex state oplog record: {error}"))?;
    let _guard = codex_global_state_oplog_io_lock()
        .lock()
        .map_err(|_| "failed to lock Codex state oplog".to_owned())?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("failed to open Codex state oplog: {error}"))?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|error| format!("failed to append Codex state oplog: {error}"))
}

fn flush_codex_global_state_oplog_if_idle() -> Result<bool, String> {
    let oplog_path = codex_global_state_oplog_path();
    if !oplog_path.exists() {
        return Ok(false);
    }
    if !codex_global_state_oplog_should_flush() {
        return Ok(false);
    }
    let _guard = codex_global_state_oplog_io_lock()
        .lock()
        .map_err(|_| "failed to lock Codex state oplog".to_owned())?;
    let ops = read_codex_global_state_oplog_unlocked();
    if ops.is_empty() {
        let _ = fs::remove_file(oplog_path);
        return Ok(false);
    }

    let state_path = codex_global_state_path();
    let mut payload = read_state_payload(&state_path).unwrap_or_default();
    apply_codex_global_state_ops(&mut payload, &ops);
    write_state_payload(&state_path, &payload)?;
    fs::remove_file(oplog_path)
        .map_err(|error| format!("failed to clear Codex state oplog: {error}"))?;
    Ok(true)
}

fn flush_or_watch_codex_global_state_oplog() {
    if !codex_global_state_oplog_has_content() {
        return;
    }
    match flush_codex_global_state_oplog_if_idle() {
        Ok(true) => {
            refresh_codex_global_project_cache();
        }
        Ok(false) | Err(_) => {
            start_codex_global_state_oplog_flush_watcher();
        }
    }
}

fn start_codex_global_state_oplog_flush_watcher() {
    if codex_global_state_oplog_flush_disabled() || !codex_global_state_oplog_has_content() {
        return;
    }
    if CODEX_GLOBAL_STATE_OPLOG_FLUSH_WATCHER_RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    thread::spawn(|| {
        loop {
            thread::sleep(OPLOG_FLUSH_POLL_INTERVAL);
            if !codex_global_state_oplog_has_content() {
                break;
            }
            if let Ok(true) = flush_codex_global_state_oplog_if_idle() {
                refresh_codex_global_project_cache();
                if !codex_global_state_oplog_has_content() {
                    break;
                }
            }
        }
        CODEX_GLOBAL_STATE_OPLOG_FLUSH_WATCHER_RUNNING.store(false, Ordering::Release);
        if !codex_global_state_oplog_flush_disabled() && codex_global_state_oplog_has_content() {
            start_codex_global_state_oplog_flush_watcher();
        }
    });
}

fn codex_global_state_oplog_has_content() -> bool {
    fs::metadata(codex_global_state_oplog_path()).is_ok_and(|metadata| metadata.len() > 0)
}

fn codex_global_state_oplog_io_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn codex_global_state_oplog_should_flush() -> bool {
    if codex_global_state_oplog_flush_disabled() {
        return false;
    }
    if env::var_os("WEGENT_FORCE_CODEX_GLOBAL_STATE_OPLOG_FLUSH").is_some() {
        return true;
    }
    !codex_app_is_running()
}

fn codex_global_state_oplog_flush_disabled() -> bool {
    env::var_os("WEGENT_DISABLE_CODEX_GLOBAL_STATE_OPLOG_FLUSH").is_some()
}

fn read_codex_global_state_oplog() -> Vec<CodexGlobalStateOplogRecord> {
    let Ok(_guard) = codex_global_state_oplog_io_lock().lock() else {
        return Vec::new();
    };
    read_codex_global_state_oplog_unlocked()
}

fn read_codex_global_state_oplog_unlocked() -> Vec<CodexGlobalStateOplogRecord> {
    let Ok(content) = fs::read_to_string(codex_global_state_oplog_path()) else {
        return Vec::new();
    };
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let mut record = serde_json::from_str::<CodexGlobalStateOplogRecord>(line).ok()?;
            if record.version != CODEX_GLOBAL_STATE_OPLOG_VERSION {
                return None;
            }
            record.workspace_path = normalize_workspace_path(&record.workspace_path);
            if record.workspace_path.is_empty() {
                return None;
            }
            record.label = record
                .label
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty());
            Some(record)
        })
        .collect()
}

fn apply_codex_global_state_ops(
    payload: &mut Map<String, Value>,
    ops: &[CodexGlobalStateOplogRecord],
) {
    for op in ops {
        match op.kind.as_str() {
            OPLOG_KIND_UPSERT => {
                upsert_codex_global_project_payload(
                    payload,
                    &op.workspace_path,
                    op.label.as_deref(),
                );
            }
            OPLOG_KIND_RENAME => {
                if let Some(label) = op.label.as_deref() {
                    rename_codex_global_project_payload(payload, &op.workspace_path, label);
                }
            }
            OPLOG_KIND_REMOVE => {
                remove_codex_global_project_payload(payload, &op.workspace_path);
            }
            _ => {}
        }
    }
}

fn cached_codex_global_project_index() -> CodexGlobalProjectIndex {
    let signature = codex_global_project_source_signature();
    if let Ok(cache) = codex_global_project_cache().read() {
        if cache.signature.as_ref() == Some(&signature) {
            return cache.index.clone();
        }
    }
    refresh_codex_global_project_cache_with_signature(signature)
}

fn refresh_codex_global_project_cache() -> CodexGlobalProjectIndex {
    refresh_codex_global_project_cache_with_signature(codex_global_project_source_signature())
}

fn refresh_codex_global_project_cache_with_signature(
    signature: CodexGlobalProjectSourceSignature,
) -> CodexGlobalProjectIndex {
    let index = build_codex_global_project_index_from_files();
    if let Ok(mut cache) = codex_global_project_cache().write() {
        cache.signature = Some(signature);
        cache.index = index.clone();
    }
    index
}

fn build_codex_global_project_index_from_files() -> CodexGlobalProjectIndex {
    let payload = load_codex_global_state();
    let pending_ops = read_codex_global_state_oplog();
    match (payload, pending_ops.is_empty()) {
        (Some(mut payload), false) => {
            apply_codex_global_state_ops(&mut payload, &pending_ops);
            index_from_payload(&payload)
        }
        (Some(payload), true) => index_from_payload(&payload),
        (None, false) => {
            let mut payload = Map::new();
            apply_codex_global_state_ops(&mut payload, &pending_ops);
            index_from_payload(&payload)
        }
        (None, true) => CodexGlobalProjectIndex::default(),
    }
}

fn codex_global_project_cache() -> &'static RwLock<CodexGlobalProjectCache> {
    static CACHE: OnceLock<RwLock<CodexGlobalProjectCache>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(CodexGlobalProjectCache::default()))
}

fn codex_global_project_source_signature() -> CodexGlobalProjectSourceSignature {
    let state_path = codex_global_state_path();
    let (state_modified, state_len) = file_source_signature(&state_path);
    let oplog_path = codex_global_state_oplog_path();
    let (oplog_modified, oplog_len) = file_source_signature(&oplog_path);
    CodexGlobalProjectSourceSignature {
        state_path,
        state_modified,
        state_len,
        oplog_path,
        oplog_modified,
        oplog_len,
    }
}

fn file_source_signature(path: &Path) -> (Option<SystemTime>, Option<u64>) {
    fs::metadata(path)
        .ok()
        .map(|metadata| (metadata.modified().ok(), Some(metadata.len())))
        .unwrap_or((None, None))
}

fn load_codex_global_state() -> Option<Map<String, Value>> {
    read_state_payload(&codex_global_state_path())
}

fn codex_global_state_path() -> PathBuf {
    codex_home().join(CODEX_GLOBAL_STATE_FILENAME)
}

fn codex_global_state_oplog_path() -> PathBuf {
    runtime_work_dir().join(CODEX_GLOBAL_STATE_OPLOG_FILENAME)
}

fn codex_home() -> PathBuf {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"))
}

fn read_state_payload(path: &Path) -> Option<Map<String, Value>> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&content)
        .ok()
        .and_then(|value| value.as_object().cloned())
}

fn write_state_payload(path: &Path, payload: &Map<String, Value>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create Codex state directory: {error}"))?;
    }
    let content = serde_json::to_vec_pretty(&Value::Object(payload.clone()))
        .map_err(|error| format!("failed to serialize Codex global state: {error}"))?;
    fs::write(path, content).map_err(|error| format!("failed to write Codex global state: {error}"))
}

fn index_from_payload(payload: &Map<String, Value>) -> CodexGlobalProjectIndex {
    let mut candidates = HashMap::<String, CodexGlobalProject>::new();
    let mut workspace_to_key = HashMap::<String, String>::new();

    for workspace_path in normalized_text_list(payload.get(SAVED_WORKSPACE_ROOTS_KEY)) {
        let project = local_project_from_path(&workspace_path, payload);
        workspace_to_key.insert(project.workspace_path.clone(), project.key.clone());
        candidates.insert(project.key.clone(), project);
    }
    for project in remote_projects_from_payload(payload) {
        workspace_to_key.insert(project.workspace_path.clone(), project.key.clone());
        candidates.insert(project.key.clone(), project);
    }

    let saved_roots = normalized_text_list(payload.get(SAVED_WORKSPACE_ROOTS_KEY));
    let project_order = normalized_text_list(payload.get(PROJECT_ORDER_KEY));
    let mut project_order_positions = HashMap::new();
    for (index, key) in project_order.iter().enumerate() {
        project_order_positions.entry(key.clone()).or_insert(index);
    }

    let mut projects = Vec::new();
    let mut next_project_order_index = 0_usize;
    for key in &saved_roots {
        if let Some(order_index) = project_order_positions.get(key).copied() {
            while next_project_order_index <= order_index {
                if let Some(order_key) = project_order.get(next_project_order_index) {
                    if let Some(project) =
                        take_project(&mut candidates, &mut workspace_to_key, order_key)
                    {
                        projects.push(project);
                    }
                }
                next_project_order_index += 1;
            }
            continue;
        }

        if let Some(project) = take_project(&mut candidates, &mut workspace_to_key, key) {
            projects.push(project);
        }
    }

    while let Some(key) = project_order.get(next_project_order_index) {
        if let Some(project) = take_project(&mut candidates, &mut workspace_to_key, key) {
            projects.push(project);
        }
        next_project_order_index += 1;
    }
    let mut remaining_projects = candidates.into_values().collect::<Vec<_>>();
    remaining_projects.sort_by(|left, right| left.key.cmp(&right.key));
    projects.extend(remaining_projects);

    let mut projects_by_key = HashMap::new();
    for (index, project) in projects.iter().enumerate() {
        projects_by_key.insert(project.key.clone(), index);
        projects_by_key.insert(project.workspace_path.clone(), index);
    }

    CodexGlobalProjectIndex {
        projects,
        projects_by_key,
        projectless_thread_ids: text_list(payload.get(PROJECTLESS_THREAD_IDS_KEY))
            .into_iter()
            .collect(),
        thread_workspace_root_hints: string_map(payload.get(THREAD_WORKSPACE_ROOT_HINTS_KEY))
            .into_iter()
            .map(|(thread_id, root)| (thread_id, normalize_path_or_raw(&root)))
            .collect(),
        project_state_loaded: project_state_loaded_from_payload(payload),
    }
}

fn project_state_loaded_from_payload(payload: &Map<String, Value>) -> bool {
    payload.contains_key(SAVED_WORKSPACE_ROOTS_KEY)
        || payload.contains_key(PROJECT_ORDER_KEY)
        || payload.contains_key(REMOTE_PROJECTS_KEY)
}

fn take_project(
    candidates: &mut HashMap<String, CodexGlobalProject>,
    workspace_to_key: &mut HashMap<String, String>,
    key: &str,
) -> Option<CodexGlobalProject> {
    if let Some(project) = candidates.remove(key) {
        workspace_to_key.remove(&project.workspace_path);
        return Some(project);
    }
    workspace_to_key
        .remove(key)
        .and_then(|candidate_key| candidates.remove(&candidate_key))
}

fn remote_projects_from_payload(payload: &Map<String, Value>) -> Vec<CodexGlobalProject> {
    let labels = string_map(payload.get(WORKSPACE_ROOT_LABELS_KEY));
    remote_project_items(payload.get(REMOTE_PROJECTS_KEY))
        .into_iter()
        .map(|item| {
            let name = item
                .label
                .or_else(|| labels.get(&item.remote_path).cloned())
                .or_else(|| labels.get(&item.key).cloned())
                .unwrap_or_else(|| workspace_label(&item.remote_path));
            CodexGlobalProject {
                key: item.key,
                workspace_path: item.remote_path,
                name,
                source: "remote".to_owned(),
                remote_host_id: Some(item.host_id),
            }
        })
        .collect()
}

struct RemoteProjectItem {
    key: String,
    host_id: String,
    remote_path: String,
    label: Option<String>,
}

fn remote_project_items(value: Option<&Value>) -> Vec<RemoteProjectItem> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let key = clean_string(item.get("id")?)?;
            let host_id = clean_string(item.get("hostId").or_else(|| item.get("host_id"))?)?;
            let remote_path = normalize_path_or_raw(&clean_string(
                item.get("remotePath").or_else(|| item.get("remote_path"))?,
            )?);
            if remote_path.is_empty() {
                return None;
            }
            Some(RemoteProjectItem {
                key,
                host_id,
                remote_path,
                label: item
                    .get("label")
                    .or_else(|| item.get("name"))
                    .and_then(clean_string),
            })
        })
        .collect()
}

fn local_project_from_path(
    workspace_path: &str,
    payload: &Map<String, Value>,
) -> CodexGlobalProject {
    let label = payload
        .get(WORKSPACE_ROOT_LABELS_KEY)
        .and_then(Value::as_object)
        .and_then(|labels| labels.get(workspace_path))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| workspace_label(workspace_path));
    local_project_from_label(workspace_path, Some(&label))
}

fn local_project_from_label(workspace_path: &str, label: Option<&str>) -> CodexGlobalProject {
    let name = label
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| workspace_label(workspace_path));
    CodexGlobalProject {
        key: workspace_path.to_owned(),
        workspace_path: workspace_path.to_owned(),
        name,
        source: "local".to_owned(),
        remote_host_id: None,
    }
}

fn upsert_codex_global_project_payload(
    payload: &mut Map<String, Value>,
    workspace_path: &str,
    label: Option<&str>,
) {
    upsert_text_list(payload, SAVED_WORKSPACE_ROOTS_KEY, workspace_path);
    upsert_project_order(payload, workspace_path);
    set_workspace_root_label(payload, workspace_path, label);
}

fn rename_codex_global_project_payload(
    payload: &mut Map<String, Value>,
    workspace_path: &str,
    label: &str,
) {
    let saved_roots = normalized_text_list(payload.get(SAVED_WORKSPACE_ROOTS_KEY));
    let project_order = normalized_text_list(payload.get(PROJECT_ORDER_KEY));
    if !saved_roots.iter().any(|value| value == workspace_path)
        && !project_order.iter().any(|value| value == workspace_path)
    {
        upsert_codex_global_project_payload(payload, workspace_path, Some(label));
        return;
    }
    set_workspace_root_label(payload, workspace_path, Some(label));
}

fn remove_codex_global_project_payload(payload: &mut Map<String, Value>, workspace_path: &str) {
    remove_text_list_item(payload, SAVED_WORKSPACE_ROOTS_KEY, workspace_path);
    remove_text_list_item(payload, PROJECT_ORDER_KEY, workspace_path);
    remove_text_list_item(payload, ACTIVE_WORKSPACE_ROOTS_KEY, workspace_path);
    remove_text_list_item(payload, PINNED_PROJECT_IDS_KEY, workspace_path);
    if let Some(labels) = payload
        .get_mut(WORKSPACE_ROOT_LABELS_KEY)
        .and_then(Value::as_object_mut)
    {
        labels.remove(workspace_path);
    }
}

fn set_workspace_root_label(
    payload: &mut Map<String, Value>,
    workspace_path: &str,
    label: Option<&str>,
) {
    let Some(label) = label.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    let labels = payload
        .entry(WORKSPACE_ROOT_LABELS_KEY.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(labels) = labels.as_object_mut() {
        labels.insert(workspace_path.to_owned(), Value::String(label.to_owned()));
    }
}

fn upsert_text_list(payload: &mut Map<String, Value>, key: &str, value: &str) {
    let mut values = text_list(payload.get(key));
    values.retain(|item| item != value);
    values.insert(0, value.to_owned());
    payload.insert(
        key.to_owned(),
        Value::Array(values.into_iter().map(Value::String).collect()),
    );
}

fn upsert_project_order(payload: &mut Map<String, Value>, preferred_value: &str) {
    let saved_roots = normalized_text_list(payload.get(SAVED_WORKSPACE_ROOTS_KEY));
    let project_order = normalized_text_list(payload.get(PROJECT_ORDER_KEY));
    let mut seen = HashSet::new();
    let mut values = Vec::new();

    push_unique_text(&mut values, &mut seen, preferred_value);
    for value in project_order {
        push_unique_text(&mut values, &mut seen, &value);
    }
    for value in saved_roots {
        push_unique_text(&mut values, &mut seen, &value);
    }

    payload.insert(
        PROJECT_ORDER_KEY.to_owned(),
        Value::Array(values.into_iter().map(Value::String).collect()),
    );
}

fn push_unique_text(values: &mut Vec<String>, seen: &mut HashSet<String>, value: &str) {
    let value = normalize_path_or_raw(value);
    if !value.is_empty() && seen.insert(value.clone()) {
        values.push(value);
    }
}

fn remove_text_list_item(payload: &mut Map<String, Value>, key: &str, value: &str) {
    let mut values = text_list(payload.get(key));
    values.retain(|item| item != value);
    payload.insert(
        key.to_owned(),
        Value::Array(values.into_iter().map(Value::String).collect()),
    );
}

fn normalized_text_list(value: Option<&Value>) -> Vec<String> {
    text_list(value)
        .into_iter()
        .map(|value| normalize_path_or_raw(&value))
        .filter(|value| !value.is_empty())
        .collect()
}

fn text_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(clean_string)
        .filter(|value| !value.is_empty())
        .collect()
}

fn string_map(value: Option<&Value>) -> HashMap<String, String> {
    value
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| Some((clean_key(key)?, clean_string(value)?)))
        .collect()
}

fn clean_key(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| normalize_path_or_raw(value))
}

fn clean_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn normalize_path_or_raw(value: &str) -> String {
    normalize_workspace_path(value)
}

#[cfg(target_os = "macos")]
fn codex_app_is_running() -> bool {
    Command::new("pgrep")
        .args(codex_app_running_probe_args())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(not(target_os = "macos"))]
fn codex_app_is_running() -> bool {
    false
}

#[cfg(any(target_os = "macos", test))]
fn codex_app_running_probe_args() -> [&'static str; 2] {
    ["-x", "Codex"]
}

#[cfg(test)]
mod tests {
    use super::{codex_app_running_probe_args, CODEX_GLOBAL_STATE_OPLOG_FILENAME};

    #[test]
    fn codex_app_running_probe_matches_only_gui_process_name() {
        assert_eq!(codex_app_running_probe_args(), ["-x", "Codex"]);
    }

    #[test]
    fn codex_global_state_oplog_uses_jsonl_filename() {
        assert_eq!(
            CODEX_GLOBAL_STATE_OPLOG_FILENAME,
            ".codex-global-state.oplog.jsonl"
        );
    }
}
