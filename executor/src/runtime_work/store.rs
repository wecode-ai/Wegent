// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    cmp::Reverse,
    collections::{btree_map::Entry, BTreeMap, BTreeSet, HashMap},
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};

use super::local_execution::PersistedLocalExecution;
use super::response::{RuntimeTaskLink, RuntimeWorkspaceLink};
use super::util::normalize_workspace_path;

const INDEX_VERSION: u64 = 1;
const DELETED_ARCHIVED_TASK_ID_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
const DELETED_ARCHIVED_TASK_ID_MAX_COUNT: usize = 2_000;
const PERSISTED_RUNTIME_HANDLE_KEYS: &[&str] = &[
    "answeredAsyncQuestions",
    "mcpAppContexts",
    "cloudProjectId",
    "cloud_project_id",
    "cloudCollaborationRound",
    "collaborationManagerContext",
    "collaborationDispatchTaskId",
    "cloudTranscript",
    "executionRequest",
    "execution_request",
    "executorSession",
    "goal",
    "lastTurnId",
    "modelSelection",
    "model_selection",
    "origin",
    super::stand_in_task_permissions::TASK_PERMISSIONS,
    "standInOwnerRequest",
    "standInResult",
    "standInResultReceipt",
    "standInRoleConsumedResults",
    "standInIssueWakeups",
    "startupFailure",
    "standInPublicTurn",
    "standInIssueReplies",
    "overloadRecoveryTurnIds",
    "quotaWait",
    "runtime",
    "supersededTranscriptTurnIds",
    "threadPath",
    "wegentTeam",
    "turnIdsBySubtask",
    "userMessagePresentations",
    "changeRequests",
    "conversationSessions",
    "connectionEventSubscriptions",
];

#[derive(Clone)]
pub(crate) struct RuntimeWorkStore {
    index_path: PathBuf,
    telemetry: Arc<telemetry::Telemetry>,
    index: Arc<Mutex<RuntimeWorkIndex>>,
    index_signature: Arc<Mutex<Option<IndexFileSignature>>>,
    write_lock: Arc<Mutex<()>>,
    last_written_payload: Arc<Mutex<Option<Vec<u8>>>>,
    #[cfg(test)]
    write_attempts: Arc<AtomicU64>,
    #[cfg(test)]
    full_task_reads: Arc<AtomicU64>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
struct RuntimeWorkIndex {
    version: u64,
    tasks: HashMap<String, RuntimeTaskLink>,
    #[serde(skip)]
    workspace_tasks: BTreeMap<String, BTreeSet<String>>,
    #[serde(skip)]
    role_children: BTreeMap<RoleChildKey, BTreeSet<String>>,
    workspaces: HashMap<String, RuntimeWorkspaceLink>,
    issue_conversations: HashMap<String, String>,
    deleted_issue_wakeups: HashMap<String, Vec<String>>,
    deleted_role_attempts: HashMap<String, DeletedRoleAttempt>,
    #[serde(default, deserialize_with = "deserialize_deleted_archived_task_ids")]
    deleted_archived_task_ids: HashMap<String, i64>,
}

fn workspace_task_key(path: &str) -> String {
    if cfg!(windows) {
        return normalize_workspace_path(
            &crate::path_compat::strip_windows_verbatim_prefix(Path::new(path)).to_string_lossy(),
        );
    }
    normalize_workspace_path(path)
}

impl RuntimeWorkIndex {
    fn advance_task_revision(&self, link: &mut RuntimeTaskLink) {
        if let Some(previous) = self.tasks.get(&link.local_task_id) {
            MetadataSnapshot::capture(previous).advance(link);
        } else if link.snapshot_revision.is_none() {
            link.snapshot_revision = Some(next_snapshot_revision(None));
        }
    }

    fn insert_task(&mut self, task: RuntimeTaskLink) {
        let id = task.local_task_id.clone();
        if task.status != "archived" {
            self.remove_deleted_role_attempt(&task);
        }
        let workspace = workspace_task_key(&task.workspace_path);
        let role_child = RoleChildKey::from_task(&task);
        let previous = self.tasks.insert(id.clone(), task);
        self.update_workspace_task(
            &id,
            previous
                .as_ref()
                .map(|task| workspace_task_key(&task.workspace_path)),
            workspace,
        );
        self.update_role_child_task(
            &id,
            previous.as_ref().and_then(RoleChildKey::from_task),
            role_child,
        );
    }

    fn rebuild_task_indexes(&mut self) {
        self.workspace_tasks.clear();
        self.role_children.clear();
        for (id, task) in &self.tasks {
            self.workspace_tasks
                .entry(workspace_task_key(&task.workspace_path))
                .or_default()
                .insert(id.clone());
            if let Some(key) = RoleChildKey::from_task(task) {
                self.role_children
                    .entry(key)
                    .or_default()
                    .insert(id.clone());
            }
        }
    }

    fn remove_workspace_task(&mut self, workspace: &str, id: &str) {
        if let Entry::Occupied(mut entry) = self.workspace_tasks.entry(workspace.to_owned()) {
            entry.get_mut().remove(id);
            if entry.get().is_empty() {
                entry.remove();
            }
        }
    }

    fn update_workspace_task(&mut self, id: &str, previous: Option<String>, workspace: String) {
        if let Some(previous) = previous {
            if previous == workspace {
                return;
            }
            self.remove_workspace_task(&previous, id);
        }
        self.workspace_tasks
            .entry(workspace)
            .or_default()
            .insert(id.to_owned());
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
struct PersistedRuntimeWorkIndex {
    version: u64,
    tasks: HashMap<String, PersistedRuntimeTask>,
    workspaces: HashMap<String, RuntimeWorkspaceLink>,
    issue_conversations: HashMap<String, String>,
    deleted_issue_wakeups: HashMap<String, Vec<String>>,
    deleted_role_attempts: HashMap<String, DeletedRoleAttempt>,
    #[serde(default, deserialize_with = "deserialize_deleted_archived_task_ids")]
    deleted_archived_task_ids: HashMap<String, i64>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(from = "PersistedRuntimeTaskInput")]
#[serde(default)]
struct PersistedRuntimeTask {
    snapshot_revision: Option<String>,
    local_task_id: String,
    thread_id: Option<String>,
    workspace_path: String,
    title: String,
    runtime: String,
    archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_execution: Option<PersistedLocalExecution>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gateway_binding: Option<crate::agents::model_gateway::GatewayBinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    execution_backend: Option<super::response::ExecutionBackend>,
    continuable: bool,
    goal_status: Option<String>,
    goal_execution_status: Option<String>,
    interaction_status: Option<String>,
    supervisor: Option<super::response::RuntimeSupervisorState>,
    created_at: i64,
    updated_at: i64,
    recency_at: i64,
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
    snapshot_revision: Option<String>,
    local_task_id: String,
    thread_id: Option<String>,
    workspace_path: String,
    title: String,
    runtime: String,
    archived: bool,
    local_execution: Option<PersistedLocalExecution>,
    gateway_binding: Option<crate::agents::model_gateway::GatewayBinding>,
    execution_backend: Option<super::response::ExecutionBackend>,
    status: Option<String>,
    continuable: bool,
    goal_status: Option<String>,
    goal_execution_status: Option<String>,
    interaction_status: Option<String>,
    supervisor: Option<super::response::RuntimeSupervisorState>,
    created_at: i64,
    updated_at: i64,
    recency_at: i64,
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
            snapshot_revision: input.snapshot_revision,
            local_execution: input.local_execution,
            gateway_binding: input.gateway_binding,
            execution_backend: input.execution_backend,
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
            goal_execution_status: input.goal_execution_status,
            interaction_status: input.interaction_status,
            supervisor: input.supervisor,
            created_at: input.created_at,
            updated_at: input.updated_at,
            recency_at: input.recency_at,
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
            snapshot_revision: link.snapshot_revision.clone(),
            local_execution: PersistedLocalExecution::from_runtime(link),
            gateway_binding: link.gateway_binding.clone(),
            execution_backend: link.execution_backend.clone(),
            local_task_id: link.local_task_id.clone(),
            thread_id: link.thread_id.clone(),
            workspace_path: link.workspace_path.clone(),
            title: link.title.clone(),
            runtime: link.runtime.clone(),
            archived: link.status == "archived",
            continuable: link.continuable,
            goal_status: link.goal_status.clone(),
            goal_execution_status: link.goal_execution_status.clone(),
            interaction_status: link.interaction_status.clone(),
            supervisor: link.supervisor.clone(),
            created_at: link.created_at,
            updated_at: link.updated_at,
            recency_at: link.recency_at,
            runtime_handle: persisted_runtime_handle(&link.runtime_handle, &link.runtime),
            parent: link.parent.clone(),
            ephemeral: link.ephemeral,
            runtime_project_key: link.runtime_project_key.clone(),
            runtime_workspace_roots: link.runtime_workspace_roots.clone(),
            project_instructions: link.project_instructions.clone(),
            project_plugin_ids: link.project_plugin_ids.clone(),
        }
    }

    fn into_runtime(self) -> RuntimeTaskLink {
        let execution = self.local_execution.clone();
        let recency_at = if self.recency_at > 0 {
            self.recency_at
        } else {
            self.updated_at.max(self.created_at)
        };
        let mut task = RuntimeTaskLink {
            snapshot_revision: self.snapshot_revision,
            local_task_id: self.local_task_id,
            thread_id: self.thread_id,
            workspace_path: self.workspace_path,
            title: self.title,
            runtime: self.runtime.clone(),
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
            goal_execution_status: self.goal_execution_status,
            interaction_status: self.interaction_status,
            supervisor: self.supervisor,
            git_info: None,
            created_at: self.created_at,
            updated_at: self.updated_at,
            recency_at,
            completed_at: None,
            runtime_handle: persisted_runtime_handle(&self.runtime_handle, &self.runtime),
            execution_state: None,
            gateway_binding: self.gateway_binding,
            execution_backend: self.execution_backend,
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
            preserve_execution_path: false,
            pinned: false,
            pinned_order: None,
        };
        if let Some(execution) = execution {
            execution.restore(&mut task);
        }
        task
    }

    fn apply_to(self, task: &mut RuntimeTaskLink) {
        task.gateway_binding = self.gateway_binding;
        task.execution_backend = self.execution_backend;
        task.thread_id = self.thread_id;
        task.workspace_path = self.workspace_path;
        task.title = self.title;
        task.runtime = self.runtime;
        task.continuable = self.continuable;
        task.goal_status = self.goal_status;
        task.goal_execution_status = self.goal_execution_status;
        task.interaction_status = self.interaction_status;
        task.supervisor = self.supervisor;
        task.created_at = self.created_at;
        task.updated_at = self.updated_at;
        task.recency_at = if self.recency_at > 0 {
            self.recency_at
        } else {
            self.updated_at.max(self.created_at)
        };
        task.runtime_handle = merge_persisted_runtime_handle(
            &task.runtime_handle,
            self.runtime_handle,
            &task.runtime,
        );
        task.parent = self.parent;
        task.ephemeral = self.ephemeral;
        task.runtime_project_key = self.runtime_project_key;
        task.runtime_workspace_roots = self.runtime_workspace_roots;
        task.project_instructions = self.project_instructions;
        task.project_plugin_ids = self.project_plugin_ids;

        if !task.running {
            if let Some(execution) = self.local_execution {
                execution.restore(task);
            }
        }
        if self.archived {
            task.status = "archived".to_owned();
        } else if task.status == "archived" {
            task.status = "active".to_owned();
        }
    }
}

fn persisted_runtime_handle(runtime_handle: &Value, runtime: &str) -> Value {
    let mut persisted = runtime_handle
        .as_object()
        .into_iter()
        .flat_map(|runtime_handle| runtime_handle.iter())
        .filter(|(key, _)| {
            PERSISTED_RUNTIME_HANDLE_KEYS.contains(&key.as_str())
                || (runtime == "claude_code" && key.as_str() == "messages")
        })
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

fn merge_persisted_runtime_handle(current: &Value, persisted: Value, runtime: &str) -> Value {
    let mut merged = persisted_runtime_handle(&persisted, runtime)
        .as_object()
        .cloned()
        .unwrap_or_default();
    let current = current.as_object();
    // Materialized profiles and coordinator identities remain memory-only.
    for key in [
        "queuePosition",
        "lastError",
        "lastErrorCode",
        "collaborationMemberRuntimeProfiles",
        "collaborationCoordinatorIdentity",
    ] {
        if let Some(value) = current.and_then(|runtime_handle| runtime_handle.get(key)) {
            merged.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(merged)
}

fn persisted_task_fingerprint(task: &RuntimeTaskLink) -> Vec<u8> {
    let mut persisted = PersistedRuntimeTask::from_runtime(task);
    persisted.updated_at = 0;
    persisted.snapshot_revision = None;
    serde_json::to_vec(&persisted).unwrap_or_default()
}

fn next_snapshot_revision(previous: Option<&str>) -> String {
    let previous = previous
        .and_then(|revision| revision.parse::<u64>().ok())
        .unwrap_or_default();
    super::events::next_runtime_event_sequence()
        .max(previous.saturating_add(1))
        .to_string()
}

struct MetadataSnapshot {
    fingerprint: Vec<u8>,
    revision: Option<String>,
}

impl MetadataSnapshot {
    fn capture(task: &RuntimeTaskLink) -> Self {
        Self {
            fingerprint: persisted_task_fingerprint(task),
            revision: task.snapshot_revision.clone(),
        }
    }

    fn advance(&self, task: &mut RuntimeTaskLink) -> bool {
        let changed = self.fingerprint != persisted_task_fingerprint(task);
        task.snapshot_revision = if changed {
            Some(next_snapshot_revision(self.revision.as_deref()))
        } else {
            self.revision.clone()
        };
        changed
    }
}

fn persisted_index_requires_migration(index: &PersistedRuntimeWorkIndex) -> bool {
    index.tasks.values().any(|task| {
        task.runtime_handle != persisted_runtime_handle(&task.runtime_handle, &task.runtime)
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct IndexFileSignature {
    len: u64,
    modified_ms: u128,
}

impl RuntimeWorkStore {
    pub(super) fn index_path(&self) -> &Path {
        &self.index_path
    }

    pub fn new(index_path: PathBuf) -> Self {
        let persisted_index = read_persisted_index_from_path(&index_path);
        let migration_required = persisted_index_requires_migration(&persisted_index);
        let index = persisted_index_into_runtime(persisted_index);
        let index_signature = index_file_signature(&index_path);
        let last_written_payload = (!migration_required)
            .then(|| serialize_index(&index).ok())
            .flatten();
        let store = Self {
            telemetry: Arc::default(),
            index_path,
            index: Arc::new(Mutex::new(index)),
            index_signature: Arc::new(Mutex::new(index_signature)),
            write_lock: Arc::new(Mutex::new(())),
            last_written_payload: Arc::new(Mutex::new(last_written_payload)),
            #[cfg(test)]
            write_attempts: Arc::new(AtomicU64::new(0)),
            #[cfg(test)]
            full_task_reads: Arc::new(AtomicU64::new(0)),
        };
        if migration_required {
            store.persist_current_index();
        }
        store
    }

    pub fn from_env() -> Self {
        let store = Self::new(default_index_path());
        store.set_telemetry_path(crate::task_runtime::LocalTaskStore::default_path());
        store
    }

    pub fn list_task_summaries(&self, include_archived: bool) -> Vec<RuntimeTaskLink> {
        self.list_filtered_task_summaries(include_archived, |_| true)
    }

    pub(super) fn workspace_task_summaries(
        &self,
        path: &str,
        matches_task: impl Fn(&RuntimeTaskLink) -> bool,
    ) -> Vec<RuntimeTaskLink> {
        self.refresh_index_from_disk_if_changed();
        let Some(index) = self.index.lock().ok() else {
            return Vec::new();
        };
        index
            .workspace_tasks
            .get(&workspace_task_key(path))
            .into_iter()
            .flatten()
            .filter_map(|id| index.tasks.get(id))
            .filter(|task| matches_task(task))
            .map(RuntimeTaskLink::list_summary)
            .collect()
    }

    pub(super) fn list_filtered_task_summaries(
        &self,
        include_archived: bool,
        matches_task: impl Fn(&RuntimeTaskLink) -> bool,
    ) -> Vec<RuntimeTaskLink> {
        self.list_filtered_task_values(
            include_archived,
            matches_task,
            RuntimeTaskLink::list_summary,
        )
    }

    pub(super) fn list_filtered_task_values<T>(
        &self,
        include_archived: bool,
        matches_task: impl Fn(&RuntimeTaskLink) -> bool,
        project: impl Fn(&RuntimeTaskLink) -> T,
    ) -> Vec<T> {
        self.refresh_index_from_disk_if_changed();
        let Some(index) = self.index.lock().ok() else {
            return Vec::new();
        };
        let mut tasks = index
            .tasks
            .values()
            .filter(|task| include_archived || task.status != "archived")
            .filter(|task| matches_task(task))
            .collect::<Vec<_>>();
        tasks.sort_by_key(|task| Reverse(task.updated_at));
        tasks.into_iter().map(project).collect()
    }

    pub(super) fn any_unarchived_task(
        &self,
        matches: impl FnMut(&RuntimeTaskLink) -> bool,
    ) -> bool {
        self.refresh_index_from_disk_if_changed();
        self.index.lock().is_ok_and(|index| {
            index
                .tasks
                .values()
                .filter(|task| task.status != "archived")
                .any(matches)
        })
    }

    pub fn get_task(&self, local_task_id: &str) -> Option<RuntimeTaskLink> {
        #[cfg(test)]
        self.full_task_reads.fetch_add(1, Ordering::Relaxed);
        self.read_task(local_task_id, Clone::clone)
    }

    #[cfg(test)]
    pub fn full_task_read_count(&self) -> u64 {
        self.full_task_reads.load(Ordering::Relaxed)
    }

    pub fn get_task_summary(&self, local_task_id: &str) -> Option<RuntimeTaskLink> {
        self.read_task(local_task_id, RuntimeTaskLink::list_summary)
    }

    /// Read task metadata without copying its buffered transcript.
    pub fn read_task<T>(
        &self,
        local_task_id: &str,
        read: impl FnOnce(&RuntimeTaskLink) -> T,
    ) -> Option<T> {
        self.refresh_index_from_disk_if_changed();
        self.read_loaded_task(local_task_id, read)
    }

    /// Read the live index after an explicit refresh outside another subsystem's lock.
    pub(super) fn read_loaded_task<T>(
        &self,
        local_task_id: &str,
        read: impl FnOnce(&RuntimeTaskLink) -> T,
    ) -> Option<T> {
        self.index.lock().ok()?.tasks.get(local_task_id).map(read)
    }

    pub fn find_summary_by_thread_id(&self, thread_id: &str) -> Option<RuntimeTaskLink> {
        self.refresh_index_from_disk_if_changed();
        self.index
            .lock()
            .ok()?
            .tasks
            .values()
            .find(|link| {
                link.thread_id.as_deref() == Some(thread_id)
                    || (link.runtime == "claude_code"
                        && link.runtime_handle["executorSession"]["sessionId"].as_str()
                            == Some(thread_id))
            })
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

    #[cfg(test)]
    pub fn mark_deleted_archived_task_ids(
        &self,
        task_ids: impl IntoIterator<Item = String>,
    ) -> io::Result<()> {
        self.mark_deleted_archived_tasks(task_ids, None)
    }

    pub fn mark_deleted_archived_link(&self, link: &RuntimeTaskLink) -> io::Result<()> {
        let ids = std::iter::once(link.local_task_id.clone()).chain(link.thread_id.iter().cloned());
        self.mark_deleted_archived_tasks(ids, Some(link))
    }

    fn mark_deleted_archived_tasks(
        &self,
        task_ids: impl IntoIterator<Item = String>,
        link: Option<&RuntimeTaskLink>,
    ) -> io::Result<()> {
        let now_ms = current_time_ms();
        self.change_index(|index| {
            for task_id in task_ids {
                if !task_id.trim().is_empty() {
                    snapshot_deleted_issue_wakeups(index, &task_id);
                    index.deleted_archived_task_ids.insert(task_id, now_ms);
                }
            }
            if let Some(link) = link {
                index.snapshot_deleted_role_attempt(link);
            }
            prune_deleted_archived_task_ids(&mut index.deleted_archived_task_ids, now_ms);
            Ok(true)
        })
    }

    pub fn unmark_deleted_archived_link(&self, link: &RuntimeTaskLink) -> io::Result<()> {
        self.change_index(|index| {
            let mut changed = index.remove_deleted_role_attempt(link);
            for task_id in std::iter::once(&link.local_task_id).chain(link.thread_id.iter()) {
                changed |= index.deleted_archived_task_ids.remove(task_id).is_some();
            }
            Ok(changed)
        })
    }

    pub fn upsert_task(&self, mut link: RuntimeTaskLink) {
        self.refresh_index_from_disk_if_changed();
        let Some(mut index) = self.index.lock().ok() else {
            return;
        };
        index.advance_task_revision(&mut link);
        self.enqueue_stand_in(super::stand_in_telemetry::snapshot(&link));
        index.insert_task(link);
        drop(index);
        self.persist_current_index();
        self.flush_stand_in();
    }

    /// A delegated task cannot be acknowledged until its link is durable.
    pub fn try_upsert_task(&self, mut link: RuntimeTaskLink) -> io::Result<RuntimeTaskLink> {
        self.change_index(|index| {
            index.advance_task_revision(&mut link);
            index.insert_task(link.clone());
            Ok(true)
        })?;
        self.enqueue_stand_in(super::stand_in_telemetry::snapshot(&link));
        self.flush_stand_in();
        Ok(link)
    }

    pub fn update_task(
        &self,
        local_task_id: &str,
        updater: impl FnOnce(&mut RuntimeTaskLink),
    ) -> Option<RuntimeTaskLink> {
        self.update_task_with_persistence(local_task_id, updater, true, Clone::clone)
    }

    /// Mutate metadata without copying the task's in-memory transcript into a discarded result.
    pub fn update_task_without_snapshot(
        &self,
        local_task_id: &str,
        updater: impl FnOnce(&mut RuntimeTaskLink),
    ) -> Option<()> {
        self.update_task_with_persistence(local_task_id, updater, true, |_| ())
    }

    /// Commit durable application metadata before making the update visible in memory.
    pub fn try_update_task(
        &self,
        local_task_id: &str,
        updater: impl FnOnce(&mut RuntimeTaskLink),
    ) -> io::Result<Option<RuntimeTaskLink>> {
        self.refresh_index_from_disk_if_changed();
        let poisoned = || io::Error::other("Runtime index lock is poisoned");
        let _write_guard = self.write_lock.lock().map_err(|_| poisoned())?;
        let mut index = self.index.lock().map_err(|_| poisoned())?;
        let mut next = index.clone();
        let Some(task) = next.tasks.get_mut(local_task_id) else {
            return Ok(None);
        };
        let previous_workspace = workspace_task_key(&task.workspace_path);
        let previous_role_child = RoleChildKey::from_task(task);
        let before = MetadataSnapshot::capture(task);
        updater(task);
        before.advance(task);
        let updated = task.clone();
        next.update_workspace_task(
            local_task_id,
            Some(previous_workspace),
            workspace_task_key(&updated.workspace_path),
        );
        next.update_role_child_task(
            local_task_id,
            previous_role_child,
            RoleChildKey::from_task(&updated),
        );
        let payload = serialize_index(&next)?;
        atomic_write_file(&self.index_path, &payload)?;
        *index = next;
        drop(index);
        *self.last_written_payload.lock().map_err(|_| poisoned())? = Some(payload);
        self.update_index_signature();
        Ok(Some(updated))
    }

    pub fn rekey_task(
        &self,
        local_task_id: &str,
        new_local_task_id: &str,
        updater: impl FnOnce(&mut RuntimeTaskLink),
    ) -> Option<RuntimeTaskLink> {
        self.refresh_index_from_disk_if_changed();
        let mut index = self.index.lock().ok()?;
        if local_task_id != new_local_task_id && index.tasks.contains_key(new_local_task_id) {
            return None;
        }
        let mut task = index.tasks.remove(local_task_id)?;
        index.remove_workspace_task(&workspace_task_key(&task.workspace_path), local_task_id);
        index.update_role_child_task(local_task_id, RoleChildKey::from_task(&task), None);
        let before = MetadataSnapshot::capture(&task);
        updater(&mut task);
        task.local_task_id = new_local_task_id.to_owned();
        before.advance(&mut task);
        let updated = task.clone();
        index.insert_task(task);
        drop(index);
        self.persist_current_index();
        Some(updated)
    }

    fn update_task_with_persistence<T>(
        &self,
        local_task_id: &str,
        updater: impl FnOnce(&mut RuntimeTaskLink),
        persist: bool,
        snapshot: impl FnOnce(&RuntimeTaskLink) -> T,
    ) -> Option<T> {
        self.refresh_index_from_disk_if_changed();
        let mut index = self.index.lock().ok()?;
        let task = index.tasks.get_mut(local_task_id)?;
        let previous_workspace = workspace_task_key(&task.workspace_path);
        let previous_role_child = RoleChildKey::from_task(task);
        let before = MetadataSnapshot::capture(task);
        let revision_before = task
            .execution_state
            .as_ref()
            .map(|state| state.revision.clone());
        let updated_at_before = task.updated_at;
        let lifecycle_before = (
            task.running,
            task.status.clone(),
            task.thread_status.clone(),
            task.turn_status.clone(),
            task.interaction_status.clone(),
            task.completed_at,
            task.runtime_handle["lastTurnId"].clone(),
            task.runtime_handle["origin"].clone(),
        );
        updater(task);
        let lifecycle_changed = lifecycle_before
            != (
                task.running,
                task.status.clone(),
                task.thread_status.clone(),
                task.turn_status.clone(),
                task.interaction_status.clone(),
                task.completed_at,
                task.runtime_handle["lastTurnId"].clone(),
                task.runtime_handle["origin"].clone(),
            );
        let metadata_changed = before.advance(task);
        if lifecycle_changed || metadata_changed || task.updated_at != updated_at_before {
            if let Some(state) = task.execution_state.as_mut() {
                // The revision versions the whole snapshot, not only native turn progress.
                if Some(&state.revision) == revision_before.as_ref() {
                    state.revision = super::events::next_runtime_event_sequence().to_string();
                }
            }
        }
        let observation = lifecycle_changed
            .then(|| super::stand_in_telemetry::snapshot(task))
            .flatten();
        self.enqueue_stand_in(observation);
        let updated = snapshot(task);
        let workspace = workspace_task_key(&task.workspace_path);
        let role_child = RoleChildKey::from_task(task);
        index.update_workspace_task(local_task_id, Some(previous_workspace), workspace);
        index.update_role_child_task(local_task_id, previous_role_child, role_child);
        let should_persist = persist && metadata_changed;
        drop(index);
        if should_persist {
            self.persist_current_index();
        }
        self.flush_stand_in();
        Some(updated)
    }

    pub fn delete_task(&self, local_task_id: &str) -> Option<RuntimeTaskLink> {
        self.refresh_index_from_disk_if_changed();
        let mut index = self.index.lock().ok()?;
        let removed = index.tasks.remove(local_task_id)?;
        index.remove_workspace_task(&workspace_task_key(&removed.workspace_path), local_task_id);
        index.update_role_child_task(local_task_id, RoleChildKey::from_task(&removed), None);
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

    pub(super) fn refresh_index_from_disk_if_changed(&self) {
        // An unchanged index needs no persistence lock on a startup read.
        let signature = index_file_signature(&self.index_path);
        if self
            .index_signature
            .lock()
            .ok()
            .is_some_and(|saved| *saved == signature)
        {
            return;
        }
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
    let mut index = RuntimeWorkIndex {
        version: persisted.version,
        workspace_tasks: BTreeMap::new(),
        role_children: BTreeMap::new(),
        tasks: persisted
            .tasks
            .into_iter()
            .map(|(task_id, task)| (task_id, task.into_runtime()))
            .collect(),
        workspaces: persisted.workspaces,
        issue_conversations: persisted.issue_conversations,
        deleted_issue_wakeups: persisted.deleted_issue_wakeups,
        deleted_role_attempts: persisted.deleted_role_attempts,
        deleted_archived_task_ids: persisted.deleted_archived_task_ids,
    };
    index.rebuild_task_indexes();
    index
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
    current.issue_conversations = persisted.issue_conversations;
    current.deleted_issue_wakeups = persisted.deleted_issue_wakeups;
    current.deleted_role_attempts = persisted.deleted_role_attempts;
    current.deleted_archived_task_ids = persisted.deleted_archived_task_ids;
    current.rebuild_task_indexes();
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
        issue_conversations: index.issue_conversations.clone(),
        deleted_issue_wakeups: index.deleted_issue_wakeups.clone(),
        deleted_role_attempts: index.deleted_role_attempts.clone(),
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

fn default_index_path() -> PathBuf {
    runtime_work_dir().join("index.json")
}

pub(crate) fn runtime_work_dir() -> PathBuf {
    executor_home().join("runtime-work")
}

fn executor_home() -> PathBuf {
    crate::config::paths::executor_home()
}

#[cfg(test)]
mod tests;

mod issue_conversations;
mod role_children;
mod task_materialization;
use issue_conversations::snapshot_deleted_issue_wakeups;
use role_children::{DeletedRoleAttempt, RoleChildKey};

mod telemetry;

mod persistence;
pub(crate) use persistence::atomic_write_file;
