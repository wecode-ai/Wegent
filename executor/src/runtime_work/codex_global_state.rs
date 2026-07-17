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
const LOCAL_PROJECTS_KEY: &str = "local-projects";
const PROJECT_WRITABLE_ROOTS_KEY: &str = "project-writable-roots";
const PROJECT_APPEARANCES_KEY: &str = "project-appearances";
const PROJECT_ORDER_KEY: &str = "project-order";
const ACTIVE_WORKSPACE_ROOTS_KEY: &str = "active-workspace-roots";
const ACTIVE_REMOTE_PROJECT_ID_KEY: &str = "active-remote-project-id";
const SELECTED_REMOTE_HOST_ID_KEY: &str = "selected-remote-host-id";
const PINNED_PROJECT_IDS_KEY: &str = "pinned-project-ids";
const PINNED_THREAD_IDS_KEY: &str = "pinned-thread-ids";
const SIDEBAR_PROJECT_THREAD_ORDERS_KEY: &str = "sidebar-project-thread-orders";
const THREAD_PROJECT_ASSIGNMENTS_KEY: &str = "thread-project-assignments";
const REMOTE_PROJECTS_KEY: &str = "remote-projects";
const PROJECTLESS_THREAD_IDS_KEY: &str = "projectless-thread-ids";
const THREAD_WORKSPACE_ROOT_HINTS_KEY: &str = "thread-workspace-root-hints";
const OPLOG_KIND_UPSERT: &str = "upsert";
const OPLOG_KIND_RENAME: &str = "rename";
const OPLOG_KIND_REMOVE: &str = "remove";
const OPLOG_KIND_REORDER_PROJECT: &str = "reorder_project";
const OPLOG_KIND_PIN_PROJECT: &str = "pin_project";
const OPLOG_KIND_UPSERT_REMOTE_PROJECT: &str = "upsert_remote_project";
const OPLOG_KIND_ACTIVATE_PROJECT: &str = "activate_project";
const OPLOG_KIND_PROJECT_APPEARANCE: &str = "project_appearance";
const OPLOG_KIND_REORDER_THREAD: &str = "reorder_thread";
const OPLOG_KIND_PIN_THREAD: &str = "pin_thread";
const OPLOG_FLUSH_POLL_INTERVAL: Duration = Duration::from_secs(3);

static CODEX_GLOBAL_STATE_OPLOG_FLUSH_WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexGlobalProject {
    pub key: String,
    pub workspace_path: String,
    pub roots: Vec<String>,
    pub name: String,
    pub source: String,
    pub kind: String,
    pub remote_host_id: Option<String>,
    pub pinned: bool,
    pub pinned_order: Option<usize>,
    pub active: bool,
    pub appearance: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexGlobalRemoteProject {
    pub id: String,
    pub host_id: String,
    pub remote_path: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct CodexGlobalProjectIndex {
    projects: Vec<CodexGlobalProject>,
    projects_by_key: HashMap<String, usize>,
    projectless_thread_ids: HashSet<String>,
    thread_workspace_root_hints: HashMap<String, String>,
    thread_project_assignments: HashMap<String, String>,
    pinned_thread_ids: Vec<String>,
    project_thread_orders: HashMap<String, Vec<String>>,
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
    #[serde(rename = "projectKey", skip_serializing_if = "Option::is_none")]
    project_key: Option<String>,
    #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    #[serde(rename = "remoteHostId", skip_serializing_if = "Option::is_none")]
    remote_host_id: Option<String>,
    #[serde(rename = "beforeId", skip_serializing_if = "Option::is_none")]
    before_id: Option<String>,
    #[serde(rename = "insertAtEnd", skip_serializing_if = "Option::is_none")]
    insert_at_end: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pinned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    appearance: Option<Value>,
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
            project_key: None,
            thread_id: None,
            remote_host_id: None,
            before_id: None,
            insert_at_end: None,
            pinned: None,
            appearance: None,
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
            .filter_map(|project| {
                project
                    .roots
                    .iter()
                    .filter(|root| path_is_within(root, &normalized))
                    .map(String::len)
                    .max()
                    .map(|root_len| (project, root_len))
            })
            .max_by_key(|(_, root_len)| *root_len)
            .map(|(project, _)| project)
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
            if let Some(project_key) = self.thread_project_assignments.get(thread_id) {
                if let Some(project) = self.project_for_key(project_key) {
                    return Some(project);
                }
            }
            if let Some(hinted_root) = self.thread_workspace_root_hints.get(thread_id) {
                if let Some(project) = self.project_by_key_or_path(hinted_root) {
                    return Some(project);
                }
            }
        }
        self.project_for_path(workspace_path)
    }

    pub fn is_pinned_thread(&self, thread_id: &str) -> bool {
        self.pinned_thread_ids
            .iter()
            .any(|value| value == thread_id)
    }

    pub fn pinned_thread_order(&self, thread_id: &str) -> Option<usize> {
        self.pinned_thread_ids
            .iter()
            .position(|value| value == thread_id)
    }

    pub fn thread_sort_order(&self, project_key: &str, thread_id: &str, fallback: usize) -> usize {
        let Some(order) = self.project_thread_orders.get(project_key) else {
            return fallback;
        };
        order
            .iter()
            .position(|value| value == thread_id)
            .unwrap_or(order.len() + fallback)
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

pub(crate) fn reorder_codex_global_projects(
    project_key: &str,
    before_project_key: Option<&str>,
    insert_at_end: bool,
) -> Result<(), String> {
    record_sidebar_op(CodexGlobalStateOplogRecord {
        kind: OPLOG_KIND_REORDER_PROJECT.to_owned(),
        project_key: clean_text(project_key),
        before_id: before_project_key.and_then(clean_text),
        insert_at_end: Some(insert_at_end),
        updated_at: now_ms(),
        ..Default::default()
    })
}

pub(crate) fn set_codex_global_project_pinned(
    project_key: &str,
    pinned: bool,
    before_project_key: Option<&str>,
) -> Result<(), String> {
    record_sidebar_op(CodexGlobalStateOplogRecord {
        kind: OPLOG_KIND_PIN_PROJECT.to_owned(),
        project_key: clean_text(project_key),
        before_id: before_project_key.and_then(clean_text),
        pinned: Some(pinned),
        updated_at: now_ms(),
        ..Default::default()
    })
}

pub(crate) fn set_codex_global_project_appearance(
    project_key: &str,
    appearance: Option<Value>,
) -> Result<(), String> {
    record_sidebar_op(CodexGlobalStateOplogRecord {
        kind: OPLOG_KIND_PROJECT_APPEARANCE.to_owned(),
        project_key: clean_text(project_key),
        appearance,
        updated_at: now_ms(),
        ..Default::default()
    })
}

pub(crate) fn sync_codex_global_remote_projects(
    projects: &[CodexGlobalRemoteProject],
) -> Result<(), String> {
    for project in projects {
        let Some(project_key) = clean_text(&project.id) else {
            continue;
        };
        let Some(remote_host_id) = clean_text(&project.host_id) else {
            continue;
        };
        let remote_path = normalize_workspace_path(&project.remote_path);
        if remote_path.is_empty() {
            continue;
        }
        append_codex_global_state_op_record(&CodexGlobalStateOplogRecord {
            kind: OPLOG_KIND_UPSERT_REMOTE_PROJECT.to_owned(),
            workspace_path: remote_path,
            project_key: Some(project_key),
            remote_host_id: Some(remote_host_id),
            label: project.label.as_deref().and_then(clean_text),
            updated_at: now_ms(),
            ..Default::default()
        })?;
    }
    flush_or_watch_codex_global_state_oplog();
    refresh_codex_global_project_cache();
    Ok(())
}

pub(crate) fn activate_codex_global_project(
    project_key: &str,
    workspace_path: &str,
    remote_host_id: Option<&str>,
) -> Result<(), String> {
    let project_key = clean_text(project_key).ok_or_else(|| "projectKey is required".to_owned())?;
    let workspace_path = normalize_workspace_path(workspace_path);
    if workspace_path.is_empty() {
        return Err("workspacePath is required".to_owned());
    }
    record_sidebar_op(CodexGlobalStateOplogRecord {
        kind: OPLOG_KIND_ACTIVATE_PROJECT.to_owned(),
        workspace_path,
        project_key: Some(project_key),
        remote_host_id: remote_host_id.and_then(clean_text),
        updated_at: now_ms(),
        ..Default::default()
    })
}

pub(crate) fn reorder_codex_global_project_thread(
    project_key: &str,
    thread_id: &str,
    before_thread_id: Option<&str>,
    insert_at_end: bool,
) -> Result<(), String> {
    record_sidebar_op(CodexGlobalStateOplogRecord {
        kind: OPLOG_KIND_REORDER_THREAD.to_owned(),
        project_key: clean_text(project_key),
        thread_id: clean_text(thread_id),
        before_id: before_thread_id.and_then(clean_text),
        insert_at_end: Some(insert_at_end),
        updated_at: now_ms(),
        ..Default::default()
    })
}

pub(crate) fn set_codex_global_thread_pinned(
    thread_id: &str,
    pinned: bool,
    before_thread_id: Option<&str>,
) -> Result<(), String> {
    record_sidebar_op(CodexGlobalStateOplogRecord {
        kind: OPLOG_KIND_PIN_THREAD.to_owned(),
        thread_id: clean_text(thread_id),
        before_id: before_thread_id.and_then(clean_text),
        pinned: Some(pinned),
        updated_at: now_ms(),
        ..Default::default()
    })
}

fn record_sidebar_op(record: CodexGlobalStateOplogRecord) -> Result<(), String> {
    if record.project_key.is_none() && record.thread_id.is_none() {
        return Err("projectKey or threadId is required".to_owned());
    }
    append_codex_global_state_op_record(&record)?;
    flush_or_watch_codex_global_state_oplog();
    refresh_codex_global_project_cache();
    Ok(())
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
    project_key: Option<&str>,
    workspace_path: &str,
    label: &str,
) -> Result<CodexGlobalProject, String> {
    let normalized_label = label.trim();
    if normalized_label.is_empty() {
        return Err("label is required".to_owned());
    }
    let normalized_workspace = normalize_workspace_path(workspace_path);
    let project_key = project_key.and_then(clean_text);
    append_codex_global_state_op_record(&CodexGlobalStateOplogRecord {
        kind: OPLOG_KIND_RENAME.to_owned(),
        workspace_path: normalized_workspace.clone(),
        project_key: project_key.clone(),
        label: Some(normalized_label.to_owned()),
        updated_at: now_ms(),
        ..Default::default()
    })?;
    flush_or_watch_codex_global_state_oplog();
    let index = refresh_codex_global_project_cache();
    Ok(project_key
        .as_deref()
        .and_then(|key| index.project_for_key(key))
        .cloned()
        .unwrap_or_else(|| local_project_from_label(&normalized_workspace, Some(normalized_label))))
}

pub(crate) fn remove_codex_global_project(
    project_key: Option<&str>,
    workspace_path: &str,
) -> Result<String, String> {
    let normalized_workspace = normalize_workspace_path(workspace_path);
    append_codex_global_state_op_record(&CodexGlobalStateOplogRecord {
        kind: OPLOG_KIND_REMOVE.to_owned(),
        workspace_path: normalized_workspace.clone(),
        project_key: project_key.and_then(clean_text),
        updated_at: now_ms(),
        ..Default::default()
    })?;
    flush_or_watch_codex_global_state_oplog();
    refresh_codex_global_project_cache();
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
        ..Default::default()
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
            if matches!(
                record.kind.as_str(),
                OPLOG_KIND_UPSERT
                    | OPLOG_KIND_RENAME
                    | OPLOG_KIND_REMOVE
                    | OPLOG_KIND_UPSERT_REMOTE_PROJECT
                    | OPLOG_KIND_ACTIVATE_PROJECT
            ) && record.workspace_path.is_empty()
            {
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
            OPLOG_KIND_UPSERT_REMOTE_PROJECT => {
                if let (Some(project_key), Some(remote_host_id)) =
                    (op.project_key.as_deref(), op.remote_host_id.as_deref())
                {
                    upsert_remote_project_payload(
                        payload,
                        project_key,
                        remote_host_id,
                        &op.workspace_path,
                        op.label.as_deref(),
                    );
                }
            }
            OPLOG_KIND_RENAME => {
                if let Some(label) = op.label.as_deref() {
                    rename_codex_global_project_payload(
                        payload,
                        op.project_key.as_deref().unwrap_or(&op.workspace_path),
                        label,
                    );
                }
            }
            OPLOG_KIND_REMOVE => {
                remove_codex_global_project_payload(
                    payload,
                    op.project_key.as_deref().unwrap_or(&op.workspace_path),
                );
            }
            OPLOG_KIND_REORDER_PROJECT => {
                if let Some(project_key) = op.project_key.as_deref() {
                    reorder_text_list_item(
                        payload,
                        PROJECT_ORDER_KEY,
                        project_key,
                        op.before_id.as_deref(),
                        op.insert_at_end.unwrap_or(false),
                    );
                }
            }
            OPLOG_KIND_PIN_PROJECT => {
                if let (Some(project_key), Some(pinned)) = (op.project_key.as_deref(), op.pinned) {
                    set_text_list_item_pinned(
                        payload,
                        PINNED_PROJECT_IDS_KEY,
                        project_key,
                        pinned,
                        op.before_id.as_deref(),
                    );
                }
            }
            OPLOG_KIND_PROJECT_APPEARANCE => {
                if let Some(project_key) = op.project_key.as_deref() {
                    set_project_appearance_payload(payload, project_key, op.appearance.clone());
                }
            }
            OPLOG_KIND_ACTIVATE_PROJECT => {
                if let Some(project_key) = op.project_key.as_deref() {
                    activate_project_payload(
                        payload,
                        project_key,
                        &op.workspace_path,
                        op.remote_host_id.as_deref(),
                    );
                }
            }
            OPLOG_KIND_REORDER_THREAD => {
                if let (Some(project_key), Some(thread_id)) =
                    (op.project_key.as_deref(), op.thread_id.as_deref())
                {
                    reorder_project_thread_payload(
                        payload,
                        project_key,
                        thread_id,
                        op.before_id.as_deref(),
                        op.insert_at_end.unwrap_or(false),
                    );
                }
            }
            OPLOG_KIND_PIN_THREAD => {
                if let (Some(thread_id), Some(pinned)) = (op.thread_id.as_deref(), op.pinned) {
                    set_text_list_item_pinned(
                        payload,
                        PINNED_THREAD_IDS_KEY,
                        thread_id,
                        pinned,
                        op.before_id.as_deref(),
                    );
                }
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
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
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
    let temporary_path = path.with_extension(format!("tmp-{}", now_ms()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)
        .map_err(|error| format!("failed to create Codex global state temp file: {error}"))?;
    file.write_all(&content)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("failed to flush Codex global state temp file: {error}"))?;
    fs::rename(&temporary_path, path).map_err(|error| {
        let _ = fs::remove_file(&temporary_path);
        format!("failed to replace Codex global state: {error}")
    })
}

fn index_from_payload(payload: &Map<String, Value>) -> CodexGlobalProjectIndex {
    let mut candidates = HashMap::<String, CodexGlobalProject>::new();
    let pinned_project_ids = text_list(payload.get(PINNED_PROJECT_IDS_KEY));
    let active_workspace_roots = normalized_text_list(payload.get(ACTIVE_WORKSPACE_ROOTS_KEY));
    let active_remote_project_id = payload
        .get(ACTIVE_REMOTE_PROJECT_ID_KEY)
        .and_then(clean_string);
    let appearances = payload
        .get(PROJECT_APPEARANCES_KEY)
        .and_then(Value::as_object);

    for workspace_path in normalized_text_list(payload.get(SAVED_WORKSPACE_ROOTS_KEY)) {
        let mut project = local_project_from_path(&workspace_path, payload);
        apply_project_ui_state(
            &mut project,
            &pinned_project_ids,
            &active_workspace_roots,
            active_remote_project_id.as_deref(),
            appearances,
        );
        candidates.insert(project.key.clone(), project);
    }
    for mut project in local_projects_from_payload(payload) {
        apply_project_ui_state(
            &mut project,
            &pinned_project_ids,
            &active_workspace_roots,
            active_remote_project_id.as_deref(),
            appearances,
        );
        candidates.insert(project.key.clone(), project);
    }
    for mut project in remote_projects_from_payload(payload) {
        apply_project_ui_state(
            &mut project,
            &pinned_project_ids,
            &active_workspace_roots,
            active_remote_project_id.as_deref(),
            appearances,
        );
        candidates.insert(project.key.clone(), project);
    }

    let mut projects = Vec::new();
    for key in reconciled_project_order(payload) {
        if let Some(project) = candidates.remove(&key) {
            projects.push(project);
        }
    }
    let mut remaining_projects = candidates.into_values().collect::<Vec<_>>();
    remaining_projects.sort_by(|left, right| left.key.cmp(&right.key));
    projects.extend(remaining_projects);

    let mut projects_by_key = HashMap::new();
    for (index, project) in projects.iter().enumerate() {
        projects_by_key.insert(project.key.clone(), index);
        for root in &project.roots {
            projects_by_key.insert(root.clone(), index);
        }
    }

    let thread_project_assignments = payload
        .get(THREAD_PROJECT_ASSIGNMENTS_KEY)
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(thread_id, assignment)| {
            let project_id = clean_string(assignment.get("projectId")?)?;
            Some((thread_id.to_owned(), project_id))
        })
        .collect();
    let project_thread_orders = payload
        .get(SIDEBAR_PROJECT_THREAD_ORDERS_KEY)
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(_, order)| {
            order.get("sortKey").and_then(clean_string).as_deref() == Some("manual")
        })
        .map(|(project_key, order)| (project_key.to_owned(), text_list(order.get("threadIds"))))
        .collect();

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
        thread_project_assignments,
        pinned_thread_ids: text_list(payload.get(PINNED_THREAD_IDS_KEY)),
        project_thread_orders,
        project_state_loaded: project_state_loaded_from_payload(payload),
    }
}

fn apply_project_ui_state(
    project: &mut CodexGlobalProject,
    pinned_project_ids: &[String],
    active_workspace_roots: &[String],
    active_remote_project_id: Option<&str>,
    appearances: Option<&Map<String, Value>>,
) {
    project.pinned_order = pinned_project_ids
        .iter()
        .position(|project_key| project_key == &project.key);
    project.pinned = project.pinned_order.is_some();
    project.active = if project.kind == "remote" {
        active_remote_project_id == Some(project.key.as_str())
    } else {
        active_workspace_roots.iter().any(|active_root| {
            project
                .roots
                .iter()
                .any(|root| normalize_workspace_path(root) == *active_root)
        })
    };
    project.appearance = appearances
        .and_then(|items| items.get(&project.key))
        .cloned();
}

fn reconciled_project_order(payload: &Map<String, Value>) -> Vec<String> {
    let mut order = text_list(payload.get(PROJECT_ORDER_KEY))
        .into_iter()
        .map(|value| normalize_path_or_raw(&value))
        .collect::<Vec<_>>();
    let mut insertion_index = 0;
    for saved_root in normalized_text_list(payload.get(SAVED_WORKSPACE_ROOTS_KEY)) {
        if let Some(index) = order.iter().position(|value| value == &saved_root) {
            insertion_index = index + 1;
        } else {
            let index = insertion_index.min(order.len());
            order.insert(index, saved_root);
            insertion_index = index + 1;
        }
    }
    order
}

fn project_state_loaded_from_payload(payload: &Map<String, Value>) -> bool {
    payload.contains_key(SAVED_WORKSPACE_ROOTS_KEY)
        || payload.contains_key(PROJECT_ORDER_KEY)
        || payload.contains_key(LOCAL_PROJECTS_KEY)
        || payload.contains_key(REMOTE_PROJECTS_KEY)
}

fn local_projects_from_payload(payload: &Map<String, Value>) -> Vec<CodexGlobalProject> {
    let writable_roots = payload
        .get(PROJECT_WRITABLE_ROOTS_KEY)
        .and_then(Value::as_object);
    payload
        .get(LOCAL_PROJECTS_KEY)
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(project_key, project)| {
            let key = project
                .get("id")
                .and_then(clean_string)
                .unwrap_or_else(|| project_key.to_owned());
            let name = project
                .get("name")
                .and_then(clean_string)
                .unwrap_or_else(|| key.clone());
            let roots = writable_roots
                .and_then(|items| items.get(&key).or_else(|| items.get(project_key)))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|root| root.get("path").and_then(clean_string))
                .map(|path| normalize_workspace_path(&path))
                .filter(|path| !path.is_empty())
                .collect::<Vec<_>>();
            CodexGlobalProject {
                key: key.clone(),
                workspace_path: roots.first().cloned().unwrap_or_else(|| key.clone()),
                roots,
                name,
                source: "local_project".to_owned(),
                kind: "local".to_owned(),
                remote_host_id: None,
                pinned: false,
                pinned_order: None,
                active: false,
                appearance: None,
            }
        })
        .collect()
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
                workspace_path: item.remote_path.clone(),
                roots: vec![item.remote_path],
                name,
                source: "remote_project".to_owned(),
                kind: "remote".to_owned(),
                remote_host_id: Some(item.host_id),
                pinned: false,
                pinned_order: None,
                active: false,
                appearance: None,
            }
        })
        .collect()
}

fn upsert_remote_project_payload(
    payload: &mut Map<String, Value>,
    project_key: &str,
    remote_host_id: &str,
    remote_path: &str,
    label: Option<&str>,
) {
    let projects = payload
        .entry(REMOTE_PROJECTS_KEY.to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !projects.is_array() {
        *projects = Value::Array(Vec::new());
    }
    let projects = projects
        .as_array_mut()
        .expect("remote projects is an array");
    let index = projects.iter().position(|project| {
        project.get("id").and_then(clean_string).as_deref() == Some(project_key)
    });
    let project = index
        .and_then(|index| projects.get_mut(index))
        .and_then(Value::as_object_mut);
    let mut project = project.cloned().unwrap_or_default();
    project.insert("id".to_owned(), Value::String(project_key.to_owned()));
    project.insert(
        "hostId".to_owned(),
        Value::String(remote_host_id.to_owned()),
    );
    project.insert(
        "remotePath".to_owned(),
        Value::String(remote_path.to_owned()),
    );
    if let Some(label) = label.and_then(clean_text) {
        project.insert("label".to_owned(), Value::String(label));
    }
    let project = Value::Object(project);
    if let Some(index) = index {
        projects[index] = project;
    } else {
        projects.push(project);
    }
    upsert_project_order(payload, project_key);
}

fn activate_project_payload(
    payload: &mut Map<String, Value>,
    project_key: &str,
    workspace_path: &str,
    remote_host_id: Option<&str>,
) {
    if let Some(remote_host_id) = remote_host_id.and_then(clean_text) {
        payload.insert(
            ACTIVE_REMOTE_PROJECT_ID_KEY.to_owned(),
            Value::String(project_key.to_owned()),
        );
        payload.insert(
            SELECTED_REMOTE_HOST_ID_KEY.to_owned(),
            Value::String(remote_host_id),
        );
        return;
    }

    payload.insert(
        ACTIVE_WORKSPACE_ROOTS_KEY.to_owned(),
        Value::Array(vec![Value::String(workspace_path.to_owned())]),
    );
    payload.remove(ACTIVE_REMOTE_PROJECT_ID_KEY);
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
        roots: vec![workspace_path.to_owned()],
        name,
        source: "legacy_root".to_owned(),
        kind: "local".to_owned(),
        remote_host_id: None,
        pinned: false,
        pinned_order: None,
        active: false,
        appearance: None,
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
    project_ref: &str,
    label: &str,
) {
    if let Some(projects) = payload
        .get_mut(LOCAL_PROJECTS_KEY)
        .and_then(Value::as_object_mut)
    {
        let entry_key = projects.iter().find_map(|(key, project)| {
            let id = project.get("id").and_then(clean_string);
            (key == project_ref || id.as_deref() == Some(project_ref)).then(|| key.clone())
        });
        if let Some(entry_key) = entry_key {
            if let Some(project) = projects.get_mut(&entry_key).and_then(Value::as_object_mut) {
                project.insert("name".to_owned(), Value::String(label.to_owned()));
            }
            return;
        }
    }
    if let Some(projects) = payload
        .get_mut(REMOTE_PROJECTS_KEY)
        .and_then(Value::as_array_mut)
    {
        if let Some(project) = projects.iter_mut().find(|project| {
            project.get("id").and_then(clean_string).as_deref() == Some(project_ref)
        }) {
            if let Some(project) = project.as_object_mut() {
                project.insert("label".to_owned(), Value::String(label.to_owned()));
            }
            return;
        }
    }
    let workspace_path = normalize_workspace_path(project_ref);
    let saved_roots = normalized_text_list(payload.get(SAVED_WORKSPACE_ROOTS_KEY));
    let project_order = normalized_text_list(payload.get(PROJECT_ORDER_KEY));
    if !saved_roots.iter().any(|value| value == &workspace_path)
        && !project_order.iter().any(|value| value == &workspace_path)
    {
        upsert_codex_global_project_payload(payload, &workspace_path, Some(label));
        return;
    }
    set_workspace_root_label(payload, &workspace_path, Some(label));
}

fn remove_codex_global_project_payload(payload: &mut Map<String, Value>, workspace_path: &str) {
    let project_ref = workspace_path;
    if let Some(projects) = payload
        .get_mut(LOCAL_PROJECTS_KEY)
        .and_then(Value::as_object_mut)
    {
        let entry_key = projects.iter().find_map(|(key, project)| {
            let id = project.get("id").and_then(clean_string);
            (key == project_ref || id.as_deref() == Some(project_ref)).then(|| key.clone())
        });
        if let Some(entry_key) = entry_key {
            projects.remove(&entry_key);
        }
    }
    if let Some(roots) = payload
        .get_mut(PROJECT_WRITABLE_ROOTS_KEY)
        .and_then(Value::as_object_mut)
    {
        roots.remove(project_ref);
    }
    if let Some(projects) = payload
        .get_mut(REMOTE_PROJECTS_KEY)
        .and_then(Value::as_array_mut)
    {
        projects.retain(|project| {
            project.get("id").and_then(clean_string).as_deref() != Some(project_ref)
        });
    }
    let workspace_path = normalize_workspace_path(workspace_path);
    remove_text_list_item(payload, SAVED_WORKSPACE_ROOTS_KEY, &workspace_path);
    remove_text_list_item(payload, PROJECT_ORDER_KEY, project_ref);
    remove_text_list_item(payload, ACTIVE_WORKSPACE_ROOTS_KEY, &workspace_path);
    remove_text_list_item(payload, PINNED_PROJECT_IDS_KEY, project_ref);
    if payload
        .get(ACTIVE_REMOTE_PROJECT_ID_KEY)
        .and_then(Value::as_str)
        == Some(project_ref)
    {
        payload.remove(ACTIVE_REMOTE_PROJECT_ID_KEY);
    }
    if let Some(labels) = payload
        .get_mut(WORKSPACE_ROOT_LABELS_KEY)
        .and_then(Value::as_object_mut)
    {
        labels.remove(&workspace_path);
    }
    for key in [PROJECT_APPEARANCES_KEY, SIDEBAR_PROJECT_THREAD_ORDERS_KEY] {
        if let Some(items) = payload.get_mut(key).and_then(Value::as_object_mut) {
            items.remove(project_ref);
        }
    }
    if let Some(assignments) = payload
        .get_mut(THREAD_PROJECT_ASSIGNMENTS_KEY)
        .and_then(Value::as_object_mut)
    {
        assignments.retain(|_, assignment| {
            assignment
                .get("projectId")
                .and_then(clean_string)
                .as_deref()
                != Some(project_ref)
        });
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

fn reorder_text_list_item(
    payload: &mut Map<String, Value>,
    key: &str,
    value: &str,
    before_value: Option<&str>,
    insert_at_end: bool,
) {
    let mut values = text_list(payload.get(key));
    values.retain(|item| item != value);
    let index = if insert_at_end {
        values.len()
    } else {
        before_value
            .and_then(|before| values.iter().position(|item| item == before))
            .unwrap_or(0)
    };
    values.insert(index, value.to_owned());
    payload.insert(
        key.to_owned(),
        Value::Array(values.into_iter().map(Value::String).collect()),
    );
}

fn set_text_list_item_pinned(
    payload: &mut Map<String, Value>,
    key: &str,
    value: &str,
    pinned: bool,
    before_value: Option<&str>,
) {
    let mut values = text_list(payload.get(key));
    values.retain(|item| item != value);
    if pinned {
        let index = before_value
            .and_then(|before| values.iter().position(|item| item == before))
            .unwrap_or(values.len());
        values.insert(index, value.to_owned());
    }
    payload.insert(
        key.to_owned(),
        Value::Array(values.into_iter().map(Value::String).collect()),
    );
}

fn set_project_appearance_payload(
    payload: &mut Map<String, Value>,
    project_key: &str,
    appearance: Option<Value>,
) {
    let appearances = payload
        .entry(PROJECT_APPEARANCES_KEY.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(appearances) = appearances.as_object_mut() else {
        return;
    };
    if let Some(appearance) = appearance.filter(Value::is_object) {
        appearances.insert(project_key.to_owned(), appearance);
    } else {
        appearances.remove(project_key);
    }
}

fn reorder_project_thread_payload(
    payload: &mut Map<String, Value>,
    project_key: &str,
    thread_id: &str,
    before_thread_id: Option<&str>,
    insert_at_end: bool,
) {
    let orders = payload
        .entry(SIDEBAR_PROJECT_THREAD_ORDERS_KEY.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(orders) = orders.as_object_mut() else {
        return;
    };
    let project_order = orders
        .entry(project_key.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(project_order) = project_order.as_object_mut() else {
        return;
    };
    let mut order = project_order
        .get("threadIds")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(clean_string).collect::<Vec<_>>())
        .unwrap_or_default();
    order.retain(|value| value != thread_id);
    let index = if insert_at_end {
        order.len()
    } else {
        before_thread_id
            .and_then(|before| order.iter().position(|value| value == before))
            .unwrap_or(0)
    };
    order.insert(index, thread_id.to_owned());
    project_order.insert("threadIds".to_owned(), serde_json::json!(order));
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

fn clean_text(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn normalize_path_or_raw(value: &str) -> String {
    normalize_workspace_path(value)
}

#[cfg(target_os = "macos")]
fn codex_app_is_running() -> bool {
    Command::new("ps")
        .args(codex_app_running_probe_args())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()
        .is_some_and(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(is_codex_gui_process_command)
        })
}

#[cfg(not(target_os = "macos"))]
fn codex_app_is_running() -> bool {
    false
}

#[cfg(any(target_os = "macos", test))]
fn codex_app_running_probe_args() -> [&'static str; 2] {
    ["-axo", "command="]
}

#[cfg(any(target_os = "macos", test))]
fn is_codex_gui_process_command(command: &str) -> bool {
    let command = command.trim();
    command.ends_with("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT")
        || command.ends_with("/Applications/Codex.app/Contents/MacOS/Codex")
        || command.contains("/ChatGPT.app/Contents/MacOS/ChatGPT ")
        || command.contains("/Codex.app/Contents/MacOS/Codex ")
}

#[cfg(test)]
mod tests {
    use super::{
        apply_codex_global_state_ops, codex_app_running_probe_args, index_from_payload,
        is_codex_gui_process_command, remove_codex_global_project_payload,
        rename_codex_global_project_payload, CodexGlobalStateOplogRecord,
        ACTIVE_REMOTE_PROJECT_ID_KEY, CODEX_GLOBAL_STATE_OPLOG_FILENAME,
        OPLOG_KIND_ACTIVATE_PROJECT, OPLOG_KIND_PIN_PROJECT, OPLOG_KIND_PIN_THREAD,
        OPLOG_KIND_PROJECT_APPEARANCE, OPLOG_KIND_REORDER_PROJECT, OPLOG_KIND_REORDER_THREAD,
        OPLOG_KIND_UPSERT_REMOTE_PROJECT, SELECTED_REMOTE_HOST_ID_KEY,
    };
    use serde_json::{json, Map, Value};

    fn payload(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("object payload")
    }

    #[test]
    fn codex_app_running_probe_reads_process_commands() {
        assert_eq!(codex_app_running_probe_args(), ["-axo", "command="]);
        assert!(is_codex_gui_process_command(
            "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
        ));
        assert!(is_codex_gui_process_command(
            "/Applications/Codex.app/Contents/MacOS/Codex"
        ));
        assert!(!is_codex_gui_process_command(
            "/Applications/ChatGPT.app/Contents/Resources/codex app-server"
        ));
    }

    #[test]
    fn codex_global_state_oplog_uses_jsonl_filename() {
        assert_eq!(
            CODEX_GLOBAL_STATE_OPLOG_FILENAME,
            ".codex-global-state.oplog.jsonl"
        );
    }

    #[test]
    fn indexes_legacy_multi_root_and_remote_projects_with_thread_precedence() {
        let payload = payload(json!({
            "electron-saved-workspace-roots": ["/repo"],
            "electron-workspace-root-labels": {"/repo": "Legacy"},
            "local-projects": {
                "multi": {"id": "multi", "name": "Multi root", "unknown": true}
            },
            "project-writable-roots": {
                "multi": [
                    {"kind": "local", "path": "/repo/nested"},
                    {"kind": "local", "path": "/other"}
                ]
            },
            "remote-projects": [
                {"id": "remote-1", "hostId": "host-1", "remotePath": "/srv/app", "label": "Remote"}
            ],
            "project-order": ["remote-1", "multi", "/repo"],
            "pinned-project-ids": ["multi"],
            "project-appearances": {"multi": {"color": "purple"}},
            "thread-project-assignments": {
                "assigned": {"projectKind": "local", "projectId": "/repo"}
            },
            "projectless-thread-ids": ["projectless"],
            "thread-workspace-root-hints": {"hinted": "/repo"},
            "pinned-thread-ids": ["assigned"],
            "sidebar-project-thread-orders": {
                "multi": {"threadIds": ["nested"], "sortKey": "manual"}
            }
        }));

        let index = index_from_payload(&payload);
        assert_eq!(
            index
                .projects()
                .iter()
                .map(|project| project.key.as_str())
                .collect::<Vec<_>>(),
            vec!["remote-1", "multi", "/repo"]
        );
        let multi = index.project_for_key("multi").expect("multi project");
        assert_eq!(multi.roots, vec!["/repo/nested", "/other"]);
        assert!(multi.pinned);
        assert_eq!(multi.pinned_order, Some(0));
        assert_eq!(multi.appearance, Some(json!({"color": "purple"})));
        assert_eq!(
            index
                .project_for_thread(Some("assigned"), "/repo/nested/file")
                .map(|project| project.key.as_str()),
            Some("/repo")
        );
        assert!(index
            .project_for_thread(Some("projectless"), "/repo/nested/file")
            .is_none());
        assert_eq!(
            index
                .project_for_thread(Some("hinted"), "/repo/nested/file")
                .map(|project| project.key.as_str()),
            Some("/repo")
        );
        assert_eq!(
            index
                .project_for_thread(Some("nested"), "/repo/nested/file")
                .map(|project| project.key.as_str()),
            Some("multi")
        );
        assert!(index.is_pinned_thread("assigned"));
        assert_eq!(index.thread_sort_order("multi", "nested", 9), 0);
    }

    #[test]
    fn remote_project_ops_register_order_and_active_selection() {
        let mut payload = payload(json!({
            "electron-saved-workspace-roots": ["/local"],
            "project-order": ["/local"]
        }));
        apply_codex_global_state_ops(
            &mut payload,
            &[
                CodexGlobalStateOplogRecord {
                    kind: OPLOG_KIND_UPSERT_REMOTE_PROJECT.to_owned(),
                    workspace_path: "/srv/app".to_owned(),
                    project_key: Some("remote-1".to_owned()),
                    remote_host_id: Some("host-1".to_owned()),
                    label: Some("Remote app".to_owned()),
                    ..Default::default()
                },
                CodexGlobalStateOplogRecord {
                    kind: OPLOG_KIND_ACTIVATE_PROJECT.to_owned(),
                    workspace_path: "/srv/app".to_owned(),
                    project_key: Some("remote-1".to_owned()),
                    remote_host_id: Some("host-1".to_owned()),
                    ..Default::default()
                },
            ],
        );

        assert_eq!(payload["project-order"], json!(["remote-1", "/local"]));
        assert_eq!(payload["remote-projects"][0]["id"], "remote-1");
        assert_eq!(payload["remote-projects"][0]["hostId"], "host-1");
        assert_eq!(payload["remote-projects"][0]["remotePath"], "/srv/app");
        assert_eq!(payload[ACTIVE_REMOTE_PROJECT_ID_KEY], "remote-1");
        assert_eq!(payload[SELECTED_REMOTE_HOST_ID_KEY], "host-1");

        let index = index_from_payload(&payload);
        assert!(index.project_for_key("remote-1").unwrap().active);
    }

    #[test]
    fn applies_semantic_sidebar_operations_without_dropping_unknown_state() {
        let mut payload = payload(json!({
            "unknown-codex-setting": {"keep": true},
            "project-order": ["a", "b", "c"],
            "pinned-project-ids": ["a"],
            "pinned-thread-ids": ["t1"],
            "sidebar-project-thread-orders": {
                "a": {"threadIds": ["t1", "t2"], "sortKey": "manual"}
            }
        }));
        let records = vec![
            CodexGlobalStateOplogRecord {
                kind: OPLOG_KIND_REORDER_PROJECT.to_owned(),
                project_key: Some("c".to_owned()),
                before_id: Some("a".to_owned()),
                ..Default::default()
            },
            CodexGlobalStateOplogRecord {
                kind: OPLOG_KIND_PIN_PROJECT.to_owned(),
                project_key: Some("b".to_owned()),
                before_id: Some("a".to_owned()),
                pinned: Some(true),
                ..Default::default()
            },
            CodexGlobalStateOplogRecord {
                kind: OPLOG_KIND_PROJECT_APPEARANCE.to_owned(),
                project_key: Some("b".to_owned()),
                appearance: Some(json!({"color": "blue"})),
                ..Default::default()
            },
            CodexGlobalStateOplogRecord {
                kind: OPLOG_KIND_REORDER_THREAD.to_owned(),
                project_key: Some("a".to_owned()),
                thread_id: Some("t2".to_owned()),
                before_id: Some("t1".to_owned()),
                ..Default::default()
            },
            CodexGlobalStateOplogRecord {
                kind: OPLOG_KIND_PIN_THREAD.to_owned(),
                thread_id: Some("t2".to_owned()),
                before_id: Some("t1".to_owned()),
                pinned: Some(true),
                ..Default::default()
            },
        ];

        apply_codex_global_state_ops(&mut payload, &records);
        assert_eq!(payload["project-order"], json!(["c", "a", "b"]));
        assert_eq!(payload["pinned-project-ids"], json!(["b", "a"]));
        assert_eq!(payload["pinned-thread-ids"], json!(["t2", "t1"]));
        assert_eq!(
            payload["sidebar-project-thread-orders"]["a"]["threadIds"],
            json!(["t2", "t1"])
        );
        assert_eq!(
            payload["sidebar-project-thread-orders"]["a"]["sortKey"],
            "manual"
        );
        assert_eq!(
            payload["project-appearances"]["b"],
            json!({"color": "blue"})
        );
        assert_eq!(payload["unknown-codex-setting"], json!({"keep": true}));
    }

    #[test]
    fn renames_and_removes_typed_projects_by_project_id() {
        let mut payload = payload(json!({
            "unknown-codex-setting": 42,
            "local-projects": {"local-entry": {"id": "local-id", "name": "Old"}},
            "project-writable-roots": {"local-id": [{"kind": "local", "path": "/repo"}]},
            "remote-projects": [{"id": "remote-id", "hostId": "host", "remotePath": "/srv", "label": "Old remote"}],
            "project-order": ["local-id", "remote-id"],
            "pinned-project-ids": ["local-id", "remote-id"],
            "project-appearances": {"local-id": {"color": "red"}},
            "sidebar-project-thread-orders": {"local-id": {"threadIds": ["t1"]}},
            "thread-project-assignments": {"t1": {"projectId": "local-id"}}
        }));

        rename_codex_global_project_payload(&mut payload, "local-id", "Renamed");
        rename_codex_global_project_payload(&mut payload, "remote-id", "Remote renamed");
        assert_eq!(payload["local-projects"]["local-entry"]["name"], "Renamed");
        assert_eq!(payload["remote-projects"][0]["label"], "Remote renamed");

        remove_codex_global_project_payload(&mut payload, "local-id");
        assert!(payload["local-projects"]["local-entry"].is_null());
        assert!(payload["project-writable-roots"]["local-id"].is_null());
        assert_eq!(payload["project-order"], json!(["remote-id"]));
        assert_eq!(payload["pinned-project-ids"], json!(["remote-id"]));
        assert!(payload["project-appearances"]["local-id"].is_null());
        assert!(payload["sidebar-project-thread-orders"]["local-id"].is_null());
        assert!(payload["thread-project-assignments"]["t1"].is_null());
        assert_eq!(payload["unknown-codex-setting"], 42);

        remove_codex_global_project_payload(&mut payload, "remote-id");
        assert_eq!(payload["remote-projects"], json!([]));
    }
}
