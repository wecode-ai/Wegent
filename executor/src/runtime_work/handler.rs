// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{HashMap, HashSet},
    env, fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use chrono::Local;
use futures_util::{stream, StreamExt};
use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::time::sleep;

use crate::{
    agents::{
        combined_codex_developer_instructions, strip_wework_browser_instructions,
        CodexActiveTurnCallback, CodexActiveTurnFinishedCallback, CodexAppServerClient,
        CodexAppServerTurnOptions, CodexRequestUserInputReceiver, CodexThreadStartedCallback,
        CODEX_APP_SERVER_TURN_CANCELLED,
    },
    local::app_ipc::{AppIpcError, RuntimeWorkHandler},
    logging::{log_executor_event, wework_debug_log},
    protocol::ExecutionRequest,
    runner::ExecutionOutcome,
};

use super::{
    codex_global_state::{
        activate_codex_global_project, open_codex_global_project,
        register_codex_global_thread_workspace_root, remove_codex_global_project,
        rename_codex_global_project, reorder_codex_global_project_thread,
        reorder_codex_global_projects, set_codex_global_project_appearance,
        set_codex_global_project_pinned, set_codex_global_thread_pinned,
        sync_codex_global_remote_projects, CodexGlobalProjectIndex, CodexGlobalRemoteProject,
    },
    codex_notifications::codex_notification,
    codex_rollout::rollout_context_usage,
    events::{emit_response_event, CodexNotificationEventMapper},
    notification_mapping::{codex_stream_debug_enabled, set_codex_stream_debug_enabled},
    response::{
        archived_conversations_response, codex_thread_is_active, search_result_item,
        workspace_response, RuntimeTaskLink, RuntimeWorkspaceLink, SearchResultMatch,
    },
    runtime_handle_messages::{
        append_runtime_handle_message, cached_messages, retain_runtime_handle_user_messages,
        set_runtime_handle_messages,
    },
    store::{runtime_work_dir, RuntimeWorkStore},
    transcript::{full_transcript_messages, transcript_messages},
    transcript_page::transcript_page,
    util::{
        apply_runtime_payload_metadata, bool_field, execution_request, id_field,
        infer_workspace_kind, integer_field, normalize_device_id, normalize_workspace_path, now_ms,
        prompt_text, runtime_task_id, string_field, workspace_group_path, workspace_path,
    },
    worktrees::{WorktreeManager, WorktreeSettingsPatch},
};

const CODEX_THREAD_LIST_PAGE_SIZE: usize = 100;
const CODEX_THREAD_LIST_MAX_ITEMS: usize = 500;
const CODEX_THREAD_SOURCE_KINDS: &[&str] = &["cli", "vscode", "exec", "appServer"];
const PENDING_THREAD_EVENT_ROUTE_PREFIX: &str = "pending:";
const ACTIVE_CODEX_TURN_WAIT_ATTEMPTS: usize = 20;
const ACTIVE_CODEX_TURN_WAIT_MS: u64 = 50;
const TRANSCRIPT_NAVIGATION_PREVIEW_CHARS: usize = 96;
const SEARCH_SNIPPET_CONTEXT_CHARS: usize = 80;
const SEARCH_SNIPPET_MAX_CHARS: usize = 240;
const ARCHIVED_BACKGROUND_THREAD_DELETE_SLOW_THRESHOLD: Duration = Duration::from_secs(5);
const ARCHIVED_BACKGROUND_DELETE_INTERVAL: Duration = Duration::from_millis(250);
const WORKTREE_AUTO_CLEANUP_IDLE_DELAY: Duration = Duration::from_secs(5 * 60);
const CODEX_OFFICIAL_PROVIDER_ID: &str = "openai";
const CODEX_OFFICIAL_PROVIDER_NAME: &str = "CodeX";

struct SpawnTurnRequest {
    local_task_id: String,
    request: ExecutionRequest,
    direct_thread_id: Option<String>,
    fork_thread_id: Option<String>,
    fork_thread_path: Option<String>,
    resume_thread_id: Option<String>,
    initial_thread_name: Option<String>,
    initial_thread_goal: Option<Value>,
}

fn standalone_chat_workspace_path(
    local_task_id: &str,
    request: &ExecutionRequest,
) -> Option<String> {
    if !is_standalone_chat_workspace(request) {
        return None;
    }
    let segment = workspace_segment(local_task_id);
    let path = home_dir()
        .join("Documents")
        .join("Codex")
        .join(Local::now().format("%Y-%m-%d").to_string())
        .join(segment);
    if let Err(error) = fs::create_dir_all(&path) {
        log_executor_event(
            "runtime work standalone workspace create failed",
            &[("error", error.to_string())],
        );
        return None;
    }
    Some(path.display().to_string())
}

fn is_standalone_chat_workspace(request: &ExecutionRequest) -> bool {
    request
        .extra
        .get("standalone_chat_workspace")
        .or_else(|| request.extra.get("standaloneChatWorkspace"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn workspace_segment(value: &str) -> String {
    let segment = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_owned();
    if segment.is_empty() {
        format!("chat-{}", now_ms())
    } else {
        segment
    }
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(env::temp_dir)
}

#[derive(Clone)]
struct CodexModelProviderInfo {
    id: String,
    display_name: String,
    kind: &'static str,
    current: bool,
}

fn current_codex_model_provider_from_config(config_response: &Value) -> CodexModelProviderInfo {
    let config = config_response
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let current_provider = string_from_map(&config, "modelProvider")
        .or_else(|| string_from_map(&config, "model_provider"))
        .unwrap_or_else(|| CODEX_OFFICIAL_PROVIDER_ID.to_owned());
    let display_name = config
        .get("model_providers")
        .or_else(|| config.get("modelProviders"))
        .and_then(Value::as_object)
        .and_then(|providers| providers.get(&current_provider))
        .and_then(Value::as_object)
        .and_then(|provider| string_from_map(provider, "name"))
        .unwrap_or_else(|| {
            if current_provider == CODEX_OFFICIAL_PROVIDER_ID {
                CODEX_OFFICIAL_PROVIDER_NAME.to_owned()
            } else {
                current_provider.clone()
            }
        });
    let kind = if current_provider == CODEX_OFFICIAL_PROVIDER_ID {
        "official"
    } else {
        "provider"
    };
    CodexModelProviderInfo {
        id: current_provider,
        display_name,
        kind,
        current: true,
    }
}

fn codex_models_with_provider(response: &Value, provider: &CodexModelProviderInfo) -> Vec<Value> {
    response
        .get("data")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let mut model = model.clone();
                    let object = model.as_object_mut()?;
                    object.insert("providerId".to_owned(), Value::String(provider.id.clone()));
                    object.insert(
                        "providerName".to_owned(),
                        Value::String(provider.display_name.clone()),
                    );
                    object.insert(
                        "providerType".to_owned(),
                        Value::String(provider.kind.to_owned()),
                    );
                    object.insert("providerCurrent".to_owned(), Value::Bool(provider.current));
                    Some(model)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn string_from_map(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .and_then(non_empty_string)
}

fn non_empty_string(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_owned())
    }
}

#[derive(Clone)]
pub struct RuntimeWorkRpcHandler {
    device_id: String,
    codex_app_server: CodexAppServerClient,
    event_tx: Option<broadcast::Sender<Value>>,
    active_local_tasks: Arc<Mutex<HashSet<String>>>,
    active_turn_cancellations: Arc<Mutex<HashMap<String, ActiveTurnCancellation>>>,
    active_codex_turns: Arc<Mutex<HashMap<String, ActiveCodexTurn>>>,
    active_request_user_inputs: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
    thread_event_routes: Arc<Mutex<HashMap<String, RuntimeThreadEventRoute>>>,
    notification_router: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    archived_delete_tx: mpsc::UnboundedSender<RuntimeTaskLink>,
    store: RuntimeWorkStore,
    worktrees: WorktreeManager,
    worktree_cleanup_generation: Arc<AtomicU64>,
    opened_workspace_roots: Arc<Mutex<HashSet<PathBuf>>>,
}

struct ActiveTurnCancellation {
    cancel: oneshot::Sender<()>,
    stopped: oneshot::Receiver<()>,
}

#[derive(Clone)]
struct ActiveCodexTurn {
    thread_id: String,
    turn_id: String,
}

struct RuntimeThreadEventRoute {
    local_task_id: String,
    request: ExecutionRequest,
    event_mapper: CodexNotificationEventMapper,
    active: bool,
}

struct SideSourceThread {
    thread_id: String,
    thread_path: Option<String>,
}

impl RuntimeThreadEventRoute {
    fn new(local_task_id: String, request: ExecutionRequest, active: bool) -> Self {
        Self {
            local_task_id,
            request,
            event_mapper: CodexNotificationEventMapper::default(),
            active,
        }
    }
}

impl RuntimeWorkRpcHandler {
    pub fn new(device_id: impl Into<String>, codex_binary: impl Into<String>) -> Self {
        let codex_binary = codex_binary.into();
        let (archived_delete_tx, archived_delete_rx) = mpsc::unbounded_channel();
        let handler = Self {
            device_id: normalize_device_id(device_id.into()),
            codex_app_server: CodexAppServerClient::new(codex_binary),
            event_tx: None,
            active_local_tasks: Arc::new(Mutex::new(HashSet::new())),
            active_turn_cancellations: Arc::new(Mutex::new(HashMap::new())),
            active_codex_turns: Arc::new(Mutex::new(HashMap::new())),
            active_request_user_inputs: Arc::new(Mutex::new(HashMap::new())),
            thread_event_routes: Arc::new(Mutex::new(HashMap::new())),
            notification_router: Arc::new(Mutex::new(None)),
            archived_delete_tx,
            store: RuntimeWorkStore::from_env(),
            worktrees: WorktreeManager::from_env(),
            worktree_cleanup_generation: Arc::new(AtomicU64::new(0)),
            opened_workspace_roots: Arc::new(Mutex::new(HashSet::new())),
        };
        handler.spawn_archived_delete_worker(archived_delete_rx);
        handler
    }

    pub fn with_event_sender(
        device_id: impl Into<String>,
        codex_binary: impl Into<String>,
        event_tx: broadcast::Sender<Value>,
    ) -> Self {
        Self {
            event_tx: Some(event_tx),
            ..Self::new(device_id, codex_binary)
        }
    }

    async fn dispatch(&self, method: &str, payload: Value) -> Result<Value, AppIpcError> {
        match method {
            "runtime.tasks.list" => self.list_tasks().await,
            "runtime.tasks.search" => self.search_tasks(payload).await,
            "runtime.tasks.transcript" => self.transcript(payload).await,
            "runtime.tasks.create" => self.create_task(payload).await,
            "runtime.tasks.send" => self.send_message(payload).await,
            "runtime.tasks.rollback" => self.rollback_task(payload).await,
            "runtime.tasks.guidance" => self.send_guidance(payload).await,
            "runtime.tasks.compact" => self.compact_task(payload).await,
            "runtime.tasks.prepare_fork_transfer" => self.prepare_fork_transfer(payload).await,
            "runtime.tasks.import_fork" => self.import_fork(payload).await,
            "runtime.tasks.archive" => self.archive_task(payload).await,
            "runtime.tasks.rename" => self.rename_task(payload).await,
            "runtime.tasks.cancel" => self.cancel_task(payload).await,
            "runtime.tasks.goal.get" => self.get_task_goal(payload).await,
            "runtime.tasks.goal.set" => self.set_task_goal(payload).await,
            "runtime.tasks.goal.clear" => self.clear_task_goal(payload).await,
            "runtime.keybindings.get" => self.get_keybindings().await,
            "runtime.keybindings.update" => self.update_keybindings(payload).await,
            "runtime.codex.models.list" => self.list_codex_models(payload).await,
            "runtime.codex.instructions.read" => self.read_codex_instructions().await,
            "runtime.codex.instructions.write" => self.write_codex_instructions(payload).await,
            "runtime.codex.personality.read" => self.read_codex_personality().await,
            "runtime.codex.personality.write" => self.write_codex_personality(payload).await,
            "runtime.codex.rate_limits.read" => self.read_codex_rate_limits().await,
            "runtime.codex.app_server.restart" => self.restart_codex_app_server().await,
            "runtime.codex.stream_debug.get" => self.get_codex_stream_debug().await,
            "runtime.codex.stream_debug.set" => self.set_codex_stream_debug(payload).await,
            "runtime.archived_conversations.list" => {
                self.list_archived_conversations(payload).await
            }
            "runtime.archived_conversations.unarchive" => self.unarchive_task(payload).await,
            "runtime.archived_conversations.delete" => self.delete_archived_task(payload).await,
            "runtime.archived_conversations.delete_bulk" => {
                self.delete_archived_tasks_bulk(payload).await
            }
            "runtime.archived_conversations.cleanup_preview" => {
                self.preview_archived_conversation_cleanup(payload).await
            }
            "runtime.archived_conversations.cleanup" => {
                self.cleanup_archived_conversations(payload).await
            }
            "runtime.archived_conversations.archive_project" => {
                self.archive_project_conversations(payload).await
            }
            "runtime.archived_conversations.archive_all" => self.archive_all_conversations().await,
            "runtime.worktrees.settings.get" => self.get_worktree_settings().await,
            "runtime.worktrees.settings.update" => self.update_worktree_settings(payload).await,
            "runtime.worktrees.prepare" => self.prepare_worktree(payload).await,
            "runtime.worktrees.list" => self.list_worktrees().await,
            "runtime.worktrees.delete" => self.delete_worktree(payload).await,
            "runtime.worktrees.restore" => self.restore_worktree(payload).await,
            "runtime.worktrees.prune" => self.prune_worktrees().await,
            "runtime.workspaces.open" => self.open_workspace(payload).await,
            "runtime.workspaces.rename" => self.rename_workspace(payload).await,
            "runtime.workspaces.remove" => self.remove_workspace(payload).await,
            "runtime.workspace.search" => self.search_workspace(payload).await,
            "runtime.sidebar.projects.reorder" => self.reorder_sidebar_projects(payload).await,
            "runtime.sidebar.projects.pin" => self.pin_sidebar_project(payload).await,
            "runtime.sidebar.projects.appearance" => {
                self.set_sidebar_project_appearance(payload).await
            }
            "runtime.sidebar.projects.sync_remote" => {
                self.sync_sidebar_remote_projects(payload).await
            }
            "runtime.sidebar.projects.activate" => self.activate_sidebar_project(payload).await,
            "runtime.sidebar.tasks.reorder" => self.reorder_sidebar_project_task(payload).await,
            "runtime.sidebar.tasks.pin" => self.pin_sidebar_task(payload).await,
            unsupported => Err(AppIpcError::new(
                "unsupported_method",
                format!("Unsupported runtime RPC method: {unsupported}"),
            )),
        }
    }

    async fn search_workspace(&self, payload: Value) -> Result<Value, AppIpcError> {
        let root = string_field(&payload, "root")
            .ok_or_else(|| AppIpcError::new("bad_request", "root is required"))?;
        let query = string_field(&payload, "query").unwrap_or_default();
        if query.trim().is_empty() {
            return Ok(json!({ "files": [] }));
        }

        let root = fs::canonicalize(&root)
            .map_err(|error| AppIpcError::new("invalid_workspace_root", error.to_string()))?;
        if !root.is_dir() {
            return Err(AppIpcError::new(
                "invalid_workspace_root",
                "Workspace search root is not a directory",
            ));
        }
        if !self.workspace_search_root_is_allowed(&root) {
            return Err(AppIpcError::new(
                "invalid_workspace_root",
                "Workspace search root has not been opened",
            ));
        }

        let cancellation_token = string_field(&payload, "cancellationToken")
            .or_else(|| string_field(&payload, "cancellation_token"));
        let response = self
            .codex_app_server
            .request(
                "fuzzyFileSearch",
                json!({
                    "query": query,
                    "roots": [root.to_string_lossy()],
                    "cancellationToken": cancellation_token,
                }),
            )
            .await
            .map_err(|error| AppIpcError::new("workspace_search_failed", error))?;
        let files = response
            .get("files")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| {
                        json!({
                            "root": item.get("root").cloned().unwrap_or(Value::Null),
                            "path": item.get("path").cloned().unwrap_or(Value::Null),
                            "fileName": item.get("file_name").cloned().unwrap_or(Value::Null),
                            "matchType": item.get("match_type").cloned().unwrap_or(Value::Null),
                            "score": item.get("score").cloned().unwrap_or(Value::Null),
                            "indices": item.get("indices").cloned().unwrap_or(Value::Null),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(json!({ "files": files }))
    }

    fn workspace_search_root_is_allowed(&self, root: &Path) -> bool {
        if self
            .opened_workspace_roots
            .lock()
            .map(|roots| {
                roots
                    .iter()
                    .any(|allowed| root == allowed || root.starts_with(allowed))
            })
            .unwrap_or(false)
        {
            return true;
        }
        let project_index = CodexGlobalProjectIndex::load();
        let project_paths = project_index
            .projects()
            .iter()
            .map(|project| project.workspace_path.as_str());
        let task_paths = self
            .store
            .list_task_summaries(true)
            .into_iter()
            .map(|task| task.workspace_path)
            .collect::<Vec<_>>();

        project_paths
            .chain(task_paths.iter().map(String::as_str))
            .filter_map(|path| fs::canonicalize(path).ok())
            .any(|allowed| root == allowed || root.starts_with(&allowed))
    }

    async fn get_worktree_settings(&self) -> Result<Value, AppIpcError> {
        let settings = self.worktrees.settings();
        let mut value = serde_json::to_value(settings)
            .map_err(|error| AppIpcError::new("worktree_settings_failed", error.to_string()))?;
        value["deviceId"] = Value::String(self.device_id.clone());
        Ok(value)
    }

    async fn update_worktree_settings(&self, payload: Value) -> Result<Value, AppIpcError> {
        let patch = serde_json::from_value::<WorktreeSettingsPatch>(payload)
            .map_err(|error| AppIpcError::new("invalid_worktree_settings", error.to_string()))?;
        let settings = self
            .worktrees
            .update_settings(patch)
            .map_err(|error| AppIpcError::new("worktree_settings_failed", error))?;
        let _ = self.worktrees.prune(&self.store.list_task_summaries(true));
        let mut value = serde_json::to_value(settings)
            .map_err(|error| AppIpcError::new("worktree_settings_failed", error.to_string()))?;
        value["deviceId"] = Value::String(self.device_id.clone());
        Ok(value)
    }

    async fn prepare_worktree(&self, payload: Value) -> Result<Value, AppIpcError> {
        let source_path = string_field(&payload, "sourcePath")
            .or_else(|| string_field(&payload, "source_path"))
            .ok_or_else(|| AppIpcError::new("bad_request", "sourcePath is required"))?;
        let worktree_id = string_field(&payload, "worktreeId")
            .or_else(|| string_field(&payload, "worktree_id"))
            .ok_or_else(|| AppIpcError::new("bad_request", "worktreeId is required"))?;
        let git_ref = string_field(&payload, "ref");
        let record = self
            .worktrees
            .prepare(Path::new(&source_path), &worktree_id, git_ref.as_deref())
            .map_err(|error| AppIpcError::new("worktree_prepare_failed", error))?;
        self.schedule_worktree_prune();
        Ok(json!({
            "success": true,
            "deviceId": self.device_id,
            "worktree": record,
            "path": record.path,
        }))
    }

    fn schedule_worktree_prune(&self) {
        let generation = self
            .worktree_cleanup_generation
            .fetch_add(1, Ordering::SeqCst)
            + 1;
        let cleanup_generation = self.worktree_cleanup_generation.clone();
        let worktrees = self.worktrees.clone();
        let store = self.store.clone();
        tokio::spawn(async move {
            loop {
                sleep(WORKTREE_AUTO_CLEANUP_IDLE_DELAY).await;
                if cleanup_generation.load(Ordering::SeqCst) != generation {
                    return;
                }

                let tasks = store.list_task_summaries(true);
                if tasks.iter().any(|task| task.running) {
                    continue;
                }

                let result = tokio::task::spawn_blocking(move || worktrees.prune(&tasks)).await;
                match result {
                    Ok(Err(error)) => {
                        wework_debug_log(&format!("background worktree cleanup failed: {error}"));
                    }
                    Err(error) => {
                        wework_debug_log(&format!(
                            "background worktree cleanup task failed: {error}"
                        ));
                    }
                    Ok(Ok(_)) => {}
                }
                return;
            }
        });
    }

    async fn list_worktrees(&self) -> Result<Value, AppIpcError> {
        let entries = self
            .worktrees
            .list(&self.store.list_task_summaries(true))
            .map_err(|error| AppIpcError::new("worktree_list_failed", error))?;
        let items = entries
            .into_iter()
            .map(|(record, tasks)| {
                json!({
                    "deviceId": self.device_id,
                    "worktreeId": record.worktree_id,
                    "path": record.path,
                    "repositoryName": record.repository_name,
                    "sourcePath": record.source_path,
                    "createdAt": record.created_at,
                    "updatedAt": record.updated_at,
                    "state": record.state,
                    "snapshotAt": record.snapshot_at,
                    "lastError": record.last_error,
                    "conversations": tasks.into_iter().map(|task| json!({
                        "deviceId": self.device_id,
                        "taskId": task.local_task_id,
                        "threadId": task.thread_id,
                        "workspacePath": task.workspace_path,
                        "title": task.title,
                        "status": task.status,
                        "running": task.running,
                        "updatedAt": task.updated_at,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({"success": true, "deviceId": self.device_id, "items": items}))
    }

    async fn delete_worktree(&self, payload: Value) -> Result<Value, AppIpcError> {
        let path = string_field(&payload, "path")
            .ok_or_else(|| AppIpcError::new("bad_request", "path is required"))?;
        let preserve_snapshot = bool_field(&payload, "preserveSnapshot")
            .or_else(|| bool_field(&payload, "preserve_snapshot"))
            .unwrap_or(true);
        let linked = self
            .store
            .list_task_summaries(true)
            .into_iter()
            .filter(|task| {
                normalize_workspace_path(&task.workspace_path) == normalize_workspace_path(&path)
            })
            .collect::<Vec<_>>();
        for task in linked.iter().filter(|task| task.status != "archived") {
            let result = self
                .archive_task(
                    json!({"taskId": task.local_task_id, "workspacePath": task.workspace_path}),
                )
                .await?;
            if result["accepted"] != true {
                return Err(AppIpcError::new(
                    "worktree_archive_failed",
                    result
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Failed to archive linked task"),
                ));
            }
        }
        let record = self
            .worktrees
            .delete(Path::new(&path), preserve_snapshot)
            .map_err(|error| AppIpcError::new("worktree_delete_failed", error))?;
        Ok(json!({
            "success": true,
            "deviceId": self.device_id,
            "worktree": record,
            "archivedTaskCount": linked.iter().filter(|task| task.status != "archived").count(),
        }))
    }

    async fn restore_worktree(&self, payload: Value) -> Result<Value, AppIpcError> {
        let path = string_field(&payload, "path")
            .or_else(|| workspace_path(&payload))
            .ok_or_else(|| AppIpcError::new("bad_request", "path is required"))?;
        let record = self
            .worktrees
            .restore(Path::new(&path))
            .map_err(|error| AppIpcError::new("worktree_restore_failed", error))?;
        Ok(json!({"success": true, "deviceId": self.device_id, "worktree": record}))
    }

    async fn prune_worktrees(&self) -> Result<Value, AppIpcError> {
        let removed = self
            .worktrees
            .prune(&self.store.list_task_summaries(true))
            .map_err(|error| AppIpcError::new("worktree_prune_failed", error))?;
        Ok(json!({"success": true, "deviceId": self.device_id, "removed": removed}))
    }

    async fn get_keybindings(&self) -> Result<Value, AppIpcError> {
        let path = runtime_work_dir().join("keybindings.json");
        let Ok(content) = fs::read_to_string(&path) else {
            return Ok(json!({ "keybindings": [] }));
        };
        let keybindings = serde_json::from_str::<Value>(&content).map_err(|error| {
            AppIpcError::new(
                "invalid_keybindings",
                format!("Failed to parse {}: {error}", path.display()),
            )
        })?;
        if !keybindings.is_array() {
            return Err(AppIpcError::new(
                "invalid_keybindings",
                "keybindings.json must contain an array",
            ));
        }
        Ok(json!({ "keybindings": keybindings }))
    }

    async fn get_codex_stream_debug(&self) -> Result<Value, AppIpcError> {
        Ok(json!({ "enabled": codex_stream_debug_enabled() }))
    }

    async fn restart_codex_app_server(&self) -> Result<Value, AppIpcError> {
        self.codex_app_server.restart().await;
        Ok(json!({ "restarted": true }))
    }

    async fn set_codex_stream_debug(&self, payload: Value) -> Result<Value, AppIpcError> {
        let Some(enabled) = bool_field(&payload, "enabled") else {
            return Err(AppIpcError::new(
                "invalid_request",
                "enabled must be a boolean",
            ));
        };
        set_codex_stream_debug_enabled(enabled);
        Ok(json!({ "enabled": codex_stream_debug_enabled() }))
    }

    async fn update_keybindings(&self, payload: Value) -> Result<Value, AppIpcError> {
        let Some(keybindings) = payload.get("keybindings").cloned() else {
            return Err(AppIpcError::new(
                "invalid_request",
                "Missing keybindings array",
            ));
        };
        if !keybindings.is_array() {
            return Err(AppIpcError::new(
                "invalid_request",
                "keybindings must be an array",
            ));
        }

        let path = runtime_work_dir().join("keybindings.json");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                AppIpcError::new(
                    "keybindings_write_failed",
                    format!("Failed to create {}: {error}", parent.display()),
                )
            })?;
        }
        let payload = serde_json::to_vec_pretty(&keybindings).map_err(|error| {
            AppIpcError::new(
                "keybindings_write_failed",
                format!("Failed to serialize keybindings: {error}"),
            )
        })?;
        fs::write(&path, payload).map_err(|error| {
            AppIpcError::new(
                "keybindings_write_failed",
                format!("Failed to write {}: {error}", path.display()),
            )
        })?;
        Ok(json!({ "keybindings": keybindings }))
    }

    async fn list_codex_models(&self, payload: Value) -> Result<Value, AppIpcError> {
        let include_hidden = bool_field(&payload, "includeHidden")
            .or_else(|| bool_field(&payload, "include_hidden"));
        let limit = integer_field(&payload, "limit")
            .filter(|value| *value > 0)
            .map(|value| value as u32);
        let cursor = string_field(&payload, "cursor");
        let model_list_params = json!({
            "limit": limit,
            "cursor": cursor,
            "includeHidden": include_hidden,
        });
        let config = self
            .codex_app_server
            .request(
                "config/read",
                json!({
                    "includeLayers": false,
                    "cwd": Value::Null,
                }),
            )
            .await
            .map_err(|error| AppIpcError::new("codex_models_unavailable", error))?;
        let provider = current_codex_model_provider_from_config(&config);
        let (available, error, models) = match self
            .codex_app_server
            .request("model/list", model_list_params)
            .await
        {
            Ok(response) => (
                true,
                Value::Null,
                codex_models_with_provider(&response, &provider),
            ),
            Err(error) => (false, Value::String(error), Vec::new()),
        };
        let provider_results = vec![json!({
            "id": provider.id,
            "displayName": provider.display_name,
            "type": provider.kind,
            "current": provider.current,
            "available": available,
            "error": error,
            "data": models.clone(),
        })];
        Ok(json!({
            "data": models,
            "providers": provider_results,
        }))
    }

    async fn read_codex_instructions(&self) -> Result<Value, AppIpcError> {
        let response = self
            .codex_app_server
            .request(
                "config/read",
                json!({
                    "includeLayers": false,
                    "cwd": Value::Null,
                }),
            )
            .await
            .map_err(|error| AppIpcError::new("codex_instructions_read_failed", error))?;
        let config = response.get("config").unwrap_or(&Value::Null);
        let developer_instructions = config
            .get("developer_instructions")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let user_developer_instructions = strip_wework_browser_instructions(developer_instructions);
        let legacy_instructions = config
            .get("instructions")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let instructions =
            if user_developer_instructions.is_empty() && !legacy_instructions.trim().is_empty() {
                self.write_codex_developer_instructions(legacy_instructions)
                    .await?;
                legacy_instructions
            } else {
                user_developer_instructions
            };
        Ok(json!({ "instructions": instructions }))
    }

    async fn write_codex_instructions(&self, payload: Value) -> Result<Value, AppIpcError> {
        let Some(instructions) = payload.get("instructions") else {
            return Err(AppIpcError::new(
                "invalid_request",
                "instructions must be a string",
            ));
        };
        let Some(instructions) = instructions.as_str() else {
            return Err(AppIpcError::new(
                "invalid_request",
                "instructions must be a string",
            ));
        };
        let response = self
            .write_codex_developer_instructions(instructions)
            .await?;
        Ok(json!({
            "instructions": instructions.trim(),
            "configPath": response.get("filePath").cloned().unwrap_or(Value::Null),
        }))
    }

    async fn write_codex_developer_instructions(
        &self,
        instructions: &str,
    ) -> Result<Value, AppIpcError> {
        let value = Value::String(combined_codex_developer_instructions(instructions));
        self.codex_app_server
            .request(
                "config/batchWrite",
                json!({
                    "edits": [
                        {
                            "keyPath": "developer_instructions",
                            "value": value,
                            "mergeStrategy": "replace",
                        },
                        {
                            "keyPath": "instructions",
                            "value": Value::Null,
                            "mergeStrategy": "replace",
                        }
                    ],
                    "filePath": Value::Null,
                    "expectedVersion": Value::Null,
                    "reloadUserConfig": true,
                }),
            )
            .await
            .map_err(|error| AppIpcError::new("codex_instructions_write_failed", error))
    }

    async fn read_codex_personality(&self) -> Result<Value, AppIpcError> {
        let response = self
            .codex_app_server
            .request(
                "config/read",
                json!({
                    "includeLayers": false,
                    "cwd": Value::Null,
                }),
            )
            .await
            .map_err(|error| AppIpcError::new("codex_personality_read_failed", error))?;
        let personality = response
            .get("config")
            .and_then(|config| config.get("personality"))
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "friendly" | "pragmatic"))
            .unwrap_or("pragmatic");
        Ok(json!({ "personality": personality }))
    }

    async fn write_codex_personality(&self, payload: Value) -> Result<Value, AppIpcError> {
        let personality = payload
            .get("personality")
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "friendly" | "pragmatic"))
            .ok_or_else(|| {
                AppIpcError::new(
                    "invalid_request",
                    "personality must be friendly or pragmatic",
                )
            })?;
        let response = self
            .codex_app_server
            .request(
                "config/batchWrite",
                json!({
                    "edits": [{
                        "keyPath": "personality",
                        "value": personality,
                        "mergeStrategy": "replace",
                    }],
                    "filePath": Value::Null,
                    "expectedVersion": Value::Null,
                    "reloadUserConfig": true,
                }),
            )
            .await
            .map_err(|error| AppIpcError::new("codex_personality_write_failed", error))?;
        Ok(json!({
            "personality": personality,
            "configPath": response.get("filePath").cloned().unwrap_or(Value::Null),
        }))
    }

    async fn read_codex_rate_limits(&self) -> Result<Value, AppIpcError> {
        self.codex_app_server
            .request("account/rateLimits/read", Value::Null)
            .await
            .map_err(|error| AppIpcError::new("codex_rate_limits_unavailable", error))
    }

    async fn list_tasks(&self) -> Result<Value, AppIpcError> {
        let started_at = Instant::now();
        log_runtime_work_list_diagnostic("started", started_at, started_at, &[]);
        let stage_started_at = Instant::now();
        let project_index = CodexGlobalProjectIndex::load();
        log_runtime_work_list_diagnostic(
            "project_index_loaded",
            started_at,
            stage_started_at,
            &[
                ("projects", project_index.projects().len().to_string()),
                (
                    "project_state_loaded",
                    project_index.has_project_state().to_string(),
                ),
            ],
        );
        let stage_started_at = Instant::now();
        let collected_links = self.collect_links(false).await;
        log_runtime_work_list_diagnostic(
            "links_collected",
            started_at,
            stage_started_at,
            &[("links", collected_links.len().to_string())],
        );
        let stage_started_at = Instant::now();
        let links = self.visible_links_for_projects(collected_links, &project_index);
        log_runtime_work_list_diagnostic(
            "project_filter_applied",
            started_at,
            stage_started_at,
            &[("visible_links", links.len().to_string())],
        );
        let stage_started_at = Instant::now();
        let workspaces = workspace_response(links, codex_project_workspaces(&project_index));
        let task_count = workspaces
            .iter()
            .filter_map(|workspace| workspace.get("tasks").and_then(Value::as_array))
            .map(Vec::len)
            .sum::<usize>();
        log_runtime_work_list_diagnostic(
            "response_built",
            started_at,
            stage_started_at,
            &[
                ("workspaces", workspaces.len().to_string()),
                ("tasks", task_count.to_string()),
            ],
        );
        log_executor_event(
            "runtime work list finished",
            &[
                ("elapsed_ms", elapsed_ms(started_at)),
                ("workspaces", workspaces.len().to_string()),
                ("tasks", task_count.to_string()),
            ],
        );
        Ok(json!({
            "success": true,
            "workspaces": workspaces,
        }))
    }

    async fn list_archived_conversations(&self, payload: Value) -> Result<Value, AppIpcError> {
        if string_field(&payload, "source")
            .is_some_and(|source| source.eq_ignore_ascii_case("cloud"))
        {
            return Ok(archived_conversations_response(Vec::new(), &self.device_id));
        }

        let mut links = self.collect_links(true).await;
        if let Some(workspace_path) = string_field(&payload, "workspacePath")
            .or_else(|| string_field(&payload, "workspace_path"))
        {
            links.retain(|link| link.workspace_path == workspace_path);
        }
        if let Some(search) = string_field(&payload, "search") {
            links.retain(|link| {
                text_match(&link.title, &search).is_some()
                    || text_match(&link.workspace_path, &search).is_some()
            });
        }
        match string_field(&payload, "sort").as_deref() {
            Some("created") => links.sort_by_key(|link| std::cmp::Reverse(link.created_at)),
            Some("alphabetical") => links.sort_by(|left, right| left.title.cmp(&right.title)),
            _ => links.sort_by_key(|link| std::cmp::Reverse(link.updated_at)),
        }

        Ok(archived_conversations_response(links, &self.device_id))
    }

    async fn search_tasks(&self, payload: Value) -> Result<Value, AppIpcError> {
        let query = string_field(&payload, "query").unwrap_or_default();
        if query.is_empty() {
            return Ok(json!({"success": true, "items": []}));
        }
        let limit = integer_field(&payload, "limit")
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| *value > 0)
            .unwrap_or(20)
            .min(100);

        let mut links = self.collect_links(false).await;
        if bool_field(&payload, "includeArchived").unwrap_or(false) {
            let archived_links = self.collect_links(true).await;
            append_unique_links(&mut links, archived_links);
        }

        let mut items = Vec::new();
        let mut matched_local_task_ids = HashSet::new();
        for link in &links {
            if let Some((match_start, match_end)) = text_match(&link.title, &query) {
                items.push(search_result_item(
                    link,
                    &self.device_id,
                    SearchResultMatch {
                        snippet: link.title.clone(),
                        match_start,
                        match_end,
                        message_id: String::new(),
                        message_role: "title".to_owned(),
                        message_created_at: json!(link.updated_at),
                    },
                ));
                matched_local_task_ids.insert(link.local_task_id.clone());
                if items.len() >= limit {
                    return Ok(json!({"success": true, "items": items}));
                }
            }
        }

        for link in &links {
            if matched_local_task_ids.contains(&link.local_task_id) {
                continue;
            }
            let Some(thread_id) = link.thread_id.as_deref() else {
                continue;
            };
            let messages = self.thread_messages(thread_id).await;
            if let Some(item) = first_message_search_result(link, &self.device_id, messages, &query)
            {
                items.push(item);
                if items.len() >= limit {
                    break;
                }
            }
        }

        Ok(json!({"success": true, "items": items}))
    }

    async fn transcript(&self, payload: Value) -> Result<Value, AppIpcError> {
        let started_at = Instant::now();
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let limit = transcript_limit(&payload);
        let before_cursor = string_field(&payload, "beforeCursor")
            .or_else(|| string_field(&payload, "before_cursor"));
        let after_cursor = string_field(&payload, "afterCursor")
            .or_else(|| string_field(&payload, "after_cursor"));
        let include_full_content = bool_field(&payload, "includeFullContent")
            .or_else(|| bool_field(&payload, "include_full_content"))
            .unwrap_or(false);
        let refresh = bool_field(&payload, "refresh")
            .or_else(|| bool_field(&payload, "forceRefresh"))
            .unwrap_or(false);
        let local_link = self.local_task_link(&local_task_id);
        let session_id = local_link
            .as_ref()
            .and_then(runtime_session_id_from_link)
            .or_else(|| runtime_session_id_from_payload(&payload));
        let running_hint = local_link.as_ref().is_some_and(|link| link.running);
        let local_execution_running = self.is_active_local_task(&local_task_id);
        if let Some(link) = local_link.as_ref().filter(|link| {
            !runtime_has_provider_transcript_reader(&link.runtime) || session_id.is_none()
        }) {
            let messages = cached_runtime_transcript_messages(link);
            log_runtime_transcript_finished(RuntimeTranscriptLog {
                started_at,
                local_task_id: &local_task_id,
                thread_id: session_id.as_deref().unwrap_or(""),
                source: "runtime_handle",
                refresh,
                running_hint,
                limit,
                before_cursor: before_cursor.as_deref(),
                after_cursor: after_cursor.as_deref(),
                message_count: messages.len(),
                running: link.running,
            });
            return Ok(cached_transcript_response(
                link,
                messages,
                None,
                local_execution_running,
                limit,
                before_cursor.as_deref(),
                after_cursor.as_deref(),
            ));
        }

        let Some(thread_id) = session_id else {
            let workspace_path = workspace_path(&payload).unwrap_or_default();
            let runtime = string_field(&payload, "runtime").unwrap_or_else(|| "runtime".to_owned());
            log_runtime_transcript_finished(RuntimeTranscriptLog {
                started_at,
                local_task_id: &local_task_id,
                thread_id: "",
                source: "pending_local_task",
                refresh,
                running_hint,
                limit,
                before_cursor: before_cursor.as_deref(),
                after_cursor: after_cursor.as_deref(),
                message_count: 0,
                running: false,
            });
            return Ok(transcript_response(TranscriptResponseInput {
                local_task_id,
                workspace_path,
                runtime,
                messages: Vec::new(),
                context_usage: None,
                running: false,
                limit,
                before_cursor,
                after_cursor,
                full_content: include_full_content,
            }));
        };

        let response = self
            .codex_app_server
            .request(
                "thread/read",
                json!({"threadId": thread_id.clone(), "includeTurns": true}),
            )
            .await
            .map_err(|error| AppIpcError::new("codex_error", error))?;
        let thread = response.get("thread").unwrap_or(&response).clone();
        let workspace_path = string_field(&thread, "cwd")
            .or_else(|| string_field(&payload, "workspacePath"))
            .or_else(|| string_field(&payload, "workspace_path"))
            .unwrap_or_default();

        let context_usage = transcript_context_usage(&thread);
        let transcript_messages = if include_full_content {
            full_transcript_messages(&thread, &self.device_id)
        } else {
            transcript_messages(&thread, &self.device_id)
        };
        let mut messages = transcript_messages;
        if local_link
            .as_ref()
            .is_some_and(|link| link.running || link.status.eq_ignore_ascii_case("failed"))
        {
            append_missing_cached_user_messages(
                &mut messages,
                local_link.as_ref().map(cached_messages).unwrap_or_default(),
            );
        }
        let running = codex_thread_has_active_turn(&thread);
        let message_count = messages.len();
        log_runtime_transcript_finished(RuntimeTranscriptLog {
            started_at,
            local_task_id: &local_task_id,
            thread_id: &thread_id,
            source: "thread_read",
            refresh,
            running_hint,
            limit,
            before_cursor: before_cursor.as_deref(),
            after_cursor: after_cursor.as_deref(),
            message_count,
            running,
        });

        Ok(transcript_response(TranscriptResponseInput {
            local_task_id,
            workspace_path,
            runtime: "codex".to_owned(),
            messages,
            context_usage,
            running,
            limit: if include_full_content { None } else { limit },
            before_cursor: if include_full_content {
                None
            } else {
                before_cursor
            },
            after_cursor: if include_full_content {
                None
            } else {
                after_cursor
            },
            full_content: include_full_content,
        }))
    }

    async fn archive_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        log_executor_event(
            "runtime task archive requested",
            &[
                (
                    "payload_task_id",
                    runtime_task_id(&payload).unwrap_or_else(|| "none".to_owned()),
                ),
                (
                    "payload_workspace_path",
                    workspace_path(&payload).unwrap_or_else(|| "none".to_owned()),
                ),
                (
                    "payload_address_task_id",
                    payload
                        .get("address")
                        .and_then(runtime_task_id)
                        .unwrap_or_else(|| "none".to_owned()),
                ),
            ],
        );
        let mut link = self.task_link_from_payload(&payload, false).await?;
        let archive_thread_id = runtime_session_id_from_link(&link);
        log_runtime_archive_link("runtime task archive resolved link", &link, false);
        if let Some(thread_id) = archive_thread_id.as_deref() {
            if let Err(error) = self
                .call_codex_thread_method("thread/archive", json!({"threadId": thread_id}))
                .await
            {
                log_executor_event(
                    "runtime task archive codex failed",
                    &[
                        ("local_task_id", link.local_task_id.clone()),
                        ("thread_id", thread_id.to_owned()),
                        ("error", error.clone()),
                    ],
                );
                if codex_error_is_missing_rollout(&error, thread_id) {
                    return Ok(self
                        .cleanup_missing_rollout_task(&link, thread_id, error)
                        .await);
                }
                return Ok(task_action_failure(&link, error));
            }
            log_executor_event(
                "runtime task archive codex accepted",
                &[
                    ("local_task_id", link.local_task_id.clone()),
                    ("thread_id", thread_id.to_owned()),
                ],
            );
            self.codex_app_server.unsubscribe_thread(thread_id).await;
            self.remove_thread_event_route(thread_id);
        } else {
            log_executor_event(
                "runtime task archive skipped codex",
                &[
                    ("local_task_id", link.local_task_id.clone()),
                    ("reason", "missing_thread_id".to_owned()),
                ],
            );
        }

        link.status = "archived".to_owned();
        link.running = false;
        link.updated_at = now_ms();
        self.upsert_local_task(link.clone());
        log_runtime_archive_link("runtime task archive stored link", &link, true);
        Ok(task_action_success(&link))
    }

    async fn cleanup_missing_rollout_task(
        &self,
        link: &RuntimeTaskLink,
        thread_id: &str,
        archive_error: String,
    ) -> Value {
        let started_at = Instant::now();
        let delete_result = self
            .call_codex_thread_method_without_list_invalidation(
                "thread/delete",
                json!({"threadId": thread_id}),
            )
            .await;
        match &delete_result {
            Ok(_) => log_executor_event(
                "runtime task archive missing rollout deleted codex thread",
                &[
                    ("local_task_id", link.local_task_id.clone()),
                    ("thread_id", thread_id.to_owned()),
                    ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
                ],
            ),
            Err(error) => log_executor_event(
                "runtime task archive missing rollout codex delete failed",
                &[
                    ("local_task_id", link.local_task_id.clone()),
                    ("thread_id", thread_id.to_owned()),
                    ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
                    ("error", error.clone()),
                ],
            ),
        }

        self.mark_archived_link_deleted(link);
        self.store.delete_task(&link.local_task_id);
        let mut response = task_action_success(link);
        response["cleaned"] = json!(true);
        response["cleanupReason"] = json!("missing_rollout");
        response["archiveError"] = json!(archive_error);
        if let Err(error) = delete_result {
            response["deleteError"] = json!(error);
        }
        response
    }

    async fn archive_project_conversations(&self, payload: Value) -> Result<Value, AppIpcError> {
        let project_index = CodexGlobalProjectIndex::load();
        let workspace_path = runtime_project_workspace_path(&payload, &project_index)
            .ok_or_else(|| AppIpcError::new("bad_request", "runtimeProjectKey is required"))?;
        let links =
            self.visible_links_for_projects(self.collect_links(false).await, &project_index);
        let project_links = links
            .into_iter()
            .filter(|link| {
                let group_path = link
                    .group_workspace_path
                    .clone()
                    .unwrap_or_else(|| workspace_group_path(&link.workspace_path));
                group_path == workspace_path
            })
            .collect::<Vec<_>>();
        self.archive_links_bulk(project_links).await
    }

    async fn archive_all_conversations(&self) -> Result<Value, AppIpcError> {
        let project_index = CodexGlobalProjectIndex::load();
        let links =
            self.visible_links_for_projects(self.collect_links(false).await, &project_index);
        self.archive_links_bulk(links).await
    }

    async fn archive_links_bulk(&self, links: Vec<RuntimeTaskLink>) -> Result<Value, AppIpcError> {
        let requested_count = links.len();
        let mut accepted_count = 0_usize;
        let mut results = Vec::new();
        for link in links {
            let result = self
                .archive_task(json!({
                    "taskId": link.local_task_id,
                    "workspacePath": link.workspace_path,
                    "runtimeHandle": link.runtime_handle,
                }))
                .await?;
            if result["accepted"].as_bool() == Some(true) {
                accepted_count += 1;
            }
            results.push(result);
        }

        Ok(json!({
            "success": accepted_count == requested_count,
            "accepted": accepted_count == requested_count,
            "requestedCount": requested_count,
            "acceptedCount": accepted_count,
            "results": results,
        }))
    }

    async fn unarchive_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let mut link = self.task_link_from_payload(&payload, true).await?;
        if let Err(error) = self
            .worktrees
            .restore_if_known(Path::new(&link.workspace_path))
        {
            return Ok(task_action_failure(&link, error));
        }
        if let Some(thread_id) = link.thread_id.as_deref() {
            if let Err(error) = self
                .call_codex_thread_method("thread/unarchive", json!({"threadId": thread_id}))
                .await
            {
                return Ok(task_action_failure(&link, error));
            }
        }

        link.status = "active".to_owned();
        link.running = false;
        link.updated_at = now_ms();
        self.upsert_local_task(link.clone());
        Ok(task_action_success(&link))
    }

    async fn rename_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let title = string_field(&payload, "title")
            .or_else(|| string_field(&payload, "name"))
            .ok_or_else(|| AppIpcError::new("bad_request", "title is required"))?;
        let mut link = self.task_link_from_payload(&payload, false).await?;
        if let Some(thread_id) = link.thread_id.as_deref() {
            if let Err(error) = self
                .call_codex_thread_method(
                    "thread/name/set",
                    json!({"threadId": thread_id, "name": title}),
                )
                .await
            {
                return Ok(task_action_failure(&link, error));
            }
        }

        link.title = title;
        link.updated_at = now_ms();
        self.upsert_local_task(link.clone());
        let mut response = task_action_success(&link);
        response["codexRename"] = json!({"stateUpdated": true});
        Ok(response)
    }

    async fn get_task_goal(&self, payload: Value) -> Result<Value, AppIpcError> {
        let link = self.task_link_from_payload(&payload, false).await?;
        let Some(thread_id) = codex_thread_id_from_link(&link) else {
            return Ok(task_goal_missing_session(&link));
        };

        match self
            .call_codex_thread_method("thread/goal/get", json!({"threadId": thread_id}))
            .await
        {
            Ok(result) => {
                self.sync_runtime_task_goal_status(
                    &link.local_task_id,
                    result
                        .get("goal")
                        .and_then(|goal| string_field(goal, "status")),
                );
                let mut response = task_action_success(&link);
                response["goal"] = result.get("goal").cloned().unwrap_or(Value::Null);
                Ok(response)
            }
            Err(error) => Ok(task_action_failure(&link, error)),
        }
    }

    async fn set_task_goal(&self, payload: Value) -> Result<Value, AppIpcError> {
        let link = self.task_link_from_payload(&payload, false).await?;
        let Some(thread_id) = codex_thread_id_from_link(&link) else {
            return Ok(task_goal_missing_session(&link));
        };

        let mut params = Map::new();
        params.insert("threadId".to_owned(), Value::String(thread_id));
        if let Some(objective) = payload.get("objective").cloned() {
            params.insert("objective".to_owned(), objective);
        }
        if let Some(status) = payload.get("status").cloned() {
            params.insert("status".to_owned(), status);
        }
        if let Some(token_budget) = payload
            .get("tokenBudget")
            .or_else(|| payload.get("token_budget"))
            .cloned()
        {
            params.insert("tokenBudget".to_owned(), token_budget);
        }

        match self
            .call_codex_thread_method("thread/goal/set", Value::Object(params))
            .await
        {
            Ok(result) => {
                self.sync_runtime_task_goal_status(
                    &link.local_task_id,
                    result
                        .get("goal")
                        .and_then(|goal| string_field(goal, "status")),
                );
                let mut response = task_action_success(&link);
                response["goal"] = result.get("goal").cloned().unwrap_or(Value::Null);
                Ok(response)
            }
            Err(error) => Ok(task_action_failure(&link, error)),
        }
    }

    async fn clear_task_goal(&self, payload: Value) -> Result<Value, AppIpcError> {
        let link = self.task_link_from_payload(&payload, false).await?;
        let Some(thread_id) = codex_thread_id_from_link(&link) else {
            return Ok(task_goal_missing_session(&link));
        };

        match self
            .call_codex_thread_method("thread/goal/clear", json!({"threadId": thread_id}))
            .await
        {
            Ok(result) => {
                self.sync_runtime_task_goal_status(&link.local_task_id, None);
                let mut response = task_action_success(&link);
                response["cleared"] = result.get("cleared").cloned().unwrap_or(Value::Bool(false));
                Ok(response)
            }
            Err(error) => Ok(task_action_failure(&link, error)),
        }
    }

    async fn delete_archived_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let link = self.task_link_from_payload(&payload, true).await?;
        Ok(self.delete_archived_link(link).await)
    }

    async fn delete_archived_link(&self, link: RuntimeTaskLink) -> Value {
        self.mark_archived_link_deleted(&link);
        if let Err(error) = self.archived_delete_tx.send(link.clone()) {
            log_executor_event(
                "runtime archived conversation background enqueue failed",
                &[
                    ("local_task_id", link.local_task_id.clone()),
                    ("error", error.to_string()),
                ],
            );
        }

        let mut response = task_action_success(&link);
        response["deleted"] = json!(true);
        response["cleanup"] = json!({
            "background": true,
            "taskId": link.local_task_id,
            "workspacePath": link.workspace_path,
        });
        response
    }

    fn spawn_archived_delete_worker(&self, mut rx: mpsc::UnboundedReceiver<RuntimeTaskLink>) {
        let handler = self.clone();
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        handle.spawn(async move {
            while let Some(link) = rx.recv().await {
                handler.delete_archived_link_background(link).await;
                sleep(ARCHIVED_BACKGROUND_DELETE_INTERVAL).await;
            }
        });
    }

    async fn delete_archived_link_background(&self, link: RuntimeTaskLink) {
        if let Some(thread_id) = link.thread_id.as_deref() {
            let started_at = Instant::now();
            match self
                .call_codex_thread_method_without_list_invalidation(
                    "thread/delete",
                    json!({"threadId": thread_id}),
                )
                .await
            {
                Ok(_) => {
                    let elapsed = started_at.elapsed();
                    if elapsed >= ARCHIVED_BACKGROUND_THREAD_DELETE_SLOW_THRESHOLD {
                        log_executor_event(
                            "runtime archived conversation background thread delete slow",
                            &[
                                ("local_task_id", link.local_task_id.clone()),
                                ("thread_id", thread_id.to_owned()),
                                ("elapsed_ms", elapsed.as_millis().to_string()),
                            ],
                        );
                    }
                }
                Err(error) => {
                    log_executor_event(
                        "runtime archived conversation background thread delete failed",
                        &[
                            ("local_task_id", link.local_task_id.clone()),
                            ("thread_id", thread_id.to_owned()),
                            ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
                            ("error", error),
                        ],
                    );
                }
            }
        }

        self.store.delete_task(&link.local_task_id);
        let cleanup_link = link.clone();
        let cleanup = tokio::task::spawn_blocking(move || {
            cleanup_task_files_response(&cleanup_link, true, false)
        })
        .await
        .unwrap_or_else(|error| {
            json!({
                "taskId": link.local_task_id,
                "workspacePath": link.workspace_path,
                "targetCount": 0,
                "cleanableCount": 0,
                "skippedCount": 0,
                "errorCount": 1,
                "bytes": 0,
                "items": [],
                "error": error.to_string(),
            })
        });
        log_executor_event(
            "runtime archived conversation background cleanup finished",
            &[
                ("local_task_id", link.local_task_id.clone()),
                (
                    "error_count",
                    cleanup
                        .get("errorCount")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        .to_string(),
                ),
            ],
        );
        let has_other_link = self.store.list_task_summaries(true).iter().any(|task| {
            normalize_workspace_path(&task.workspace_path)
                == normalize_workspace_path(&link.workspace_path)
        });
        if !has_other_link {
            if let Err(error) = self
                .worktrees
                .forget_if_known(Path::new(&link.workspace_path))
            {
                log_executor_event(
                    "runtime archived conversation worktree snapshot cleanup failed",
                    &[("local_task_id", link.local_task_id), ("error", error)],
                );
            }
        }
    }

    async fn delete_archived_tasks_bulk(&self, payload: Value) -> Result<Value, AppIpcError> {
        let links = self.archived_cleanup_links(&payload).await?;
        let results = stream::iter(links)
            .map(|link| {
                let handler = self.clone();
                async move { handler.delete_archived_link(link).await }
            })
            .buffer_unordered(8)
            .collect::<Vec<_>>()
            .await;
        let deleted_count = results
            .iter()
            .filter(|result| result["deleted"] == true)
            .count();

        Ok(json!({
            "success": true,
            "accepted": true,
            "requestedCount": results.len(),
            "acceptedCount": deleted_count,
            "deletedCount": deleted_count,
            "results": results,
        }))
    }

    async fn preview_archived_conversation_cleanup(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let links = self.archived_cleanup_links(&payload).await?;
        let previews = links
            .iter()
            .map(cleanup_task_files_preview)
            .collect::<Vec<_>>();
        Ok(cleanup_summary_response(previews, false))
    }

    async fn cleanup_archived_conversations(&self, payload: Value) -> Result<Value, AppIpcError> {
        let links = self.archived_cleanup_links(&payload).await?;
        let results = links
            .iter()
            .map(|link| cleanup_task_files_response(link, true, false))
            .collect::<Vec<_>>();
        Ok(cleanup_summary_response(results, true))
    }

    async fn create_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = id_field(&payload, "taskId")
            .or_else(|| id_field(&payload, "task_id"))
            .unwrap_or_else(|| format!("codex-local-{}", now_ms()));
        let payload_workspace_path = workspace_path(&payload);
        let title = string_field(&payload, "title")
            .or_else(|| string_field(&payload, "message"))
            .unwrap_or_else(|| local_task_id.clone());
        let mut request = execution_request(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "executionRequest is required"))?;
        apply_runtime_payload_metadata(&mut request, &payload);
        Self::log_execution_request_summary("runtime.tasks.create", &request);
        let workspace_path = payload_workspace_path
            .or_else(|| request.cwd().map(str::to_owned))
            .or_else(|| standalone_chat_workspace_path(&local_task_id, &request))
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        if request.project_workspace_path.is_none() {
            request.project_workspace_path = Some(workspace_path.clone());
        }

        let mut link = RuntimeTaskLink::new_pending(
            local_task_id.clone(),
            workspace_path.clone(),
            title.clone(),
        );
        link.ephemeral = request.ephemeral || bool_field(&payload, "ephemeral").unwrap_or(false);
        set_runtime_handle_model_selection(&mut link.runtime_handle, &payload);
        if let Some(message) = cached_user_message(&local_task_id, &request, &payload) {
            set_runtime_handle_messages(&mut link.runtime_handle, vec![message]);
        }
        let runtime_handle = runtime_handle_json(&link);
        self.upsert_local_task(link);
        self.schedule_worktree_prune();
        let initial_thread_goal = initial_thread_goal_from_payload(&payload);
        let mut side_source = side_source_thread(&payload);
        if let Some(source) = &mut side_source {
            if source.thread_path.is_none() {
                source.thread_path = self.thread_path_for_id(&source.thread_id).await;
            }
        }
        self.spawn_turn(SpawnTurnRequest {
            local_task_id: local_task_id.clone(),
            request,
            direct_thread_id: None,
            fork_thread_id: side_source.as_ref().map(|source| source.thread_id.clone()),
            fork_thread_path: side_source.and_then(|source| source.thread_path),
            resume_thread_id: None,
            initial_thread_name: Some(title),
            initial_thread_goal,
        });

        Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": self.device_id,
            "taskId": local_task_id,
            "workspacePath": workspace_path,
            "runtime": "codex",
            "runtimeHandle": runtime_handle,
        }))
    }

    fn log_execution_request_summary(method: &str, request: &ExecutionRequest) {
        let model_config = &request.model_config;
        let base_url = model_config
            .get("base_url")
            .and_then(Value::as_str)
            .unwrap_or("");
        let api_key_present = model_config
            .get("api_key")
            .and_then(Value::as_str)
            .map(|value| !value.is_empty())
            .unwrap_or(false);
        let use_user_config = model_config
            .get("runtime_config")
            .and_then(Value::as_object)
            .and_then(|config| config.get("codex"))
            .and_then(Value::as_object)
            .and_then(|codex| codex.get("use_user_config"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let model_id = model_config
            .get("model_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let keys: Vec<String> = model_config
            .as_object()
            .map(|object| object.keys().cloned().collect())
            .unwrap_or_default();
        wework_debug_log(&format!(
            "{method} task_id={} model_id={} base_url={} api_key_present={} use_user_config={} model_config_keys={:?}",
            request.task_id, model_id, base_url, api_key_present, use_user_config, keys
        ));
    }

    async fn send_message(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let existing_link = self.local_task_link(&local_task_id);
        let payload_execution_request = execution_request(&payload);
        let has_execution_request = payload_execution_request.is_some();
        if let Some(response) = request_user_input_response(&payload) {
            return self
                .send_request_user_input_response(&local_task_id, response)
                .await;
        }
        if existing_link
            .as_ref()
            .is_some_and(|link| link.running && self.is_active_local_task(&link.local_task_id))
        {
            return Ok(json!({
                "success": false,
                "error": "runtime task is already running",
                "code": "bad_request",
            }));
        }
        let workspace_path = workspace_path(&payload)
            .or_else(|| {
                existing_link
                    .as_ref()
                    .map(|link| link.workspace_path.clone())
            })
            .unwrap_or_default();
        if let Err(error) = self.worktrees.restore_if_known(Path::new(&workspace_path)) {
            return Ok(json!({
                "success": false,
                "accepted": false,
                "error": error,
                "code": "worktree_restore_required",
                "taskId": local_task_id,
                "workspacePath": workspace_path,
            }));
        }
        let mut request = payload_execution_request
            .ok_or_else(|| AppIpcError::new("bad_request", "executionRequest is required"))?;
        apply_runtime_payload_metadata(&mut request, &payload);
        request.new_session = false;
        Self::log_execution_request_summary("runtime.tasks.send", &request);
        if request.project_workspace_path.is_none() && !workspace_path.is_empty() {
            request.project_workspace_path = Some(workspace_path.clone());
        }
        let recovered_link = self
            .recover_send_task_link(&payload, &local_task_id, existing_link.as_ref())
            .await;
        let Some(thread_id) = runtime_session_id_from_payload(&payload)
            .or_else(|| {
                existing_link
                    .as_ref()
                    .and_then(runtime_session_id_from_link)
            })
            .or_else(|| {
                recovered_link
                    .as_ref()
                    .and_then(runtime_session_id_from_link)
            })
        else {
            return Ok(json!({
                "success": false,
                "error": "runtime task session is not ready",
                "code": "missing_runtime_session",
                "taskId": local_task_id,
                "runtime": "codex",
            }));
        };

        let mut fields = task_fields(&request.task_id, &request.subtask_id);
        fields.push(("local_task_id", local_task_id.clone()));
        fields.push(("thread_id", thread_id.clone()));
        fields.push(("workspace_path", workspace_path.clone()));
        fields.push(("has_execution_request", has_execution_request.to_string()));
        fields.push(("prompt_len", prompt_text(&request.prompt).len().to_string()));
        if let Some(cwd) = request.cwd() {
            fields.push(("cwd", cwd.to_owned()));
        }
        fields.push((
            "model_id",
            string_field(&request.model_config, "model_id")
                .or_else(|| string_field(&request.model_config, "modelId"))
                .unwrap_or_default(),
        ));
        log_executor_event("runtime work send prepared", &fields);

        self.mark_task_running_for_send(
            &local_task_id,
            &thread_id,
            &workspace_path,
            &request,
            &payload,
        );
        self.schedule_worktree_prune();
        let link_for_send = existing_link.as_ref().or(recovered_link.as_ref());
        let ephemeral = request.ephemeral || link_for_send.is_some_and(|link| link.ephemeral);
        let direct_thread_id = ephemeral.then(|| thread_id.clone());
        let resume_thread_id = (!ephemeral).then_some(thread_id);

        self.spawn_turn(SpawnTurnRequest {
            local_task_id: local_task_id.clone(),
            request,
            direct_thread_id,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id,
            initial_thread_name: None,
            initial_thread_goal: None,
        });

        Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": self.device_id,
            "taskId": local_task_id,
            "runtime": "codex",
        }))
    }

    async fn rollback_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let requested_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let existing_link = self.task_link_from_payload(&payload, false).await?;
        let local_task_id = existing_link.local_task_id.clone();
        if existing_link.running && self.is_active_local_task(&existing_link.local_task_id) {
            return Ok(json!({
                "success": false,
                "accepted": false,
                "taskId": local_task_id,
                "runtime": "codex",
                "error": "runtime task is already running",
                "code": "bad_request",
            }));
        }

        let mut request = execution_request(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "executionRequest is required"))?;
        let workspace_path =
            workspace_path(&payload).unwrap_or_else(|| existing_link.workspace_path.clone());
        apply_runtime_payload_metadata(&mut request, &payload);
        request.new_session = false;
        if request.project_workspace_path.is_none() && !workspace_path.is_empty() {
            request.project_workspace_path = Some(workspace_path.clone());
        }
        let Some(thread_id) = runtime_session_id_from_payload(&payload)
            .or_else(|| runtime_session_id_from_link(&existing_link))
        else {
            return Ok(task_goal_missing_session(&existing_link));
        };

        let mut fields = task_fields(&request.task_id, &request.subtask_id);
        fields.push(("requested_task_id", requested_task_id));
        fields.push(("local_task_id", local_task_id.clone()));
        fields.push(("thread_id", thread_id.clone()));
        fields.push(("workspace_path", workspace_path.clone()));
        fields.push(("prompt_len", prompt_text(&request.prompt).len().to_string()));
        if let Some(cwd) = request.cwd() {
            fields.push(("cwd", cwd.to_owned()));
        }
        log_executor_event("runtime work rollback prepared", &fields);

        if let Err(error) = self
            .call_codex_thread_method(
                "thread/rollback",
                json!({
                    "threadId": thread_id,
                    "numTurns": 1,
                }),
            )
            .await
        {
            return Ok(task_action_failure(&existing_link, error));
        }

        self.trim_runtime_handle_after_rollback(&local_task_id);
        self.mark_task_running_for_send(
            &local_task_id,
            &thread_id,
            &workspace_path,
            &request,
            &payload,
        );
        self.spawn_turn(SpawnTurnRequest {
            local_task_id: local_task_id.clone(),
            request,
            direct_thread_id: Some(thread_id),
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: None,
            initial_thread_name: None,
            initial_thread_goal: None,
        });

        Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": self.device_id,
            "taskId": local_task_id,
            "runtime": "codex",
        }))
    }

    async fn send_guidance(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let message = string_field(&payload, "message")
            .or_else(|| string_field(&payload, "guidance"))
            .map(|value| value.trim().to_owned())
            .unwrap_or_default();
        let steer_input = guidance_input_items(&message, payload.get("attachments"));
        if steer_input.is_empty() {
            return Err(AppIpcError::new(
                "bad_request",
                "message or image attachment is required",
            ));
        }
        let Some(active_turn) = self.wait_for_active_codex_turn(&local_task_id).await else {
            return Ok(json!({
                "success": false,
                "accepted": false,
                "error": "no active turn to guide",
                "code": "no_active_turn",
                "taskId": local_task_id,
                "runtime": "codex",
            }));
        };

        let guidance_id = string_field(&payload, "client_guidance_id")
            .or_else(|| string_field(&payload, "clientGuidanceId"))
            .unwrap_or_else(|| format!("guidance-{}", now_ms()));
        let additional_context = payload
            .get("additionalContext")
            .or_else(|| payload.get("additional_context"))
            .filter(|value| value.is_object())
            .cloned();
        match self
            .codex_app_server
            .steer_turn(
                &active_turn.thread_id,
                &active_turn.turn_id,
                Value::Array(steer_input),
                additional_context,
            )
            .await
        {
            Ok(turn_id) => Ok(json!({
                "success": true,
                "accepted": true,
                "guidance_id": guidance_id,
                "guidanceId": guidance_id,
                "taskId": local_task_id,
                "turnId": turn_id,
                "runtime": "codex",
            })),
            Err(error) => {
                let code = codex_guidance_failure_code(&error);
                Ok(json!({
                    "success": false,
                    "accepted": false,
                    "error": error,
                    "code": code,
                    "taskId": local_task_id,
                    "runtime": "codex",
                }))
            }
        }
    }

    async fn compact_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let link = self.task_link_from_payload(&payload, false).await?;
        let Some(thread_id) = runtime_session_id_from_payload(&payload)
            .or_else(|| runtime_session_id_from_link(&link))
        else {
            return Ok(task_action_failure(
                &link,
                "runtime task session is not ready".to_owned(),
            ));
        };

        let thread_id = match self.resume_codex_thread_for_action(&link, &thread_id).await {
            Ok(resumed_thread_id) => resumed_thread_id,
            Err(error) => return Ok(task_action_failure(&link, error)),
        };
        self.register_thread_event_route(
            &thread_id,
            link.local_task_id.clone(),
            runtime_event_request_from_link(&link),
            true,
        );
        match self
            .call_codex_thread_method("thread/compact/start", json!({"threadId": thread_id}))
            .await
        {
            Ok(_) => {
                self.store.update_task(&local_task_id, |stored| {
                    stored.updated_at = now_ms();
                });
                Ok(task_action_success(&link))
            }
            Err(error) => Ok(task_action_failure(&link, error)),
        }
    }

    async fn resume_codex_thread_for_action(
        &self,
        link: &RuntimeTaskLink,
        thread_id: &str,
    ) -> Result<String, String> {
        let mut params = Map::new();
        params.insert("threadId".to_owned(), Value::String(thread_id.to_owned()));
        params.insert(
            "approvalPolicy".to_owned(),
            Value::String("never".to_owned()),
        );
        params.insert("excludeTurns".to_owned(), Value::Bool(true));
        if !link.workspace_path.trim().is_empty() {
            params.insert("cwd".to_owned(), Value::String(link.workspace_path.clone()));
        }
        if let Some(thread_path) = runtime_thread_path_from_link(link) {
            params.insert("path".to_owned(), Value::String(thread_path));
        }

        let response = self
            .call_codex_thread_method_without_list_invalidation(
                "thread/resume",
                Value::Object(params),
            )
            .await?;
        Ok(response
            .get("thread")
            .and_then(|thread| string_field(thread, "id"))
            .unwrap_or_else(|| thread_id.to_owned()))
    }

    async fn send_request_user_input_response(
        &self,
        local_task_id: &str,
        response: Value,
    ) -> Result<Value, AppIpcError> {
        let sender = self
            .active_request_user_inputs
            .lock()
            .ok()
            .and_then(|requests| requests.get(local_task_id).cloned());
        let Some(sender) = sender else {
            return Ok(json!({
                "success": false,
                "error": "request_user_input is not pending",
                "code": "missing_request_user_input",
                "taskId": local_task_id,
                "runtime": "codex",
            }));
        };
        if sender.send(response).await.is_err() {
            return Ok(json!({
                "success": false,
                "error": "request_user_input response channel is closed",
                "code": "closed_request_user_input",
                "taskId": local_task_id,
                "runtime": "codex",
            }));
        }
        Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": self.device_id,
            "taskId": local_task_id,
            "runtime": "codex",
        }))
    }

    async fn cancel_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let link = self
            .store
            .update_task(&local_task_id, |link| {
                link.status = "cancelled".to_owned();
                link.running = false;
                link.updated_at = now_ms();
                link.completed_at = Some(link.updated_at);
            })
            .or_else(|| self.local_task_link(&local_task_id));
        self.resolve_pending_request_user_input_for_cancel(&local_task_id);
        if !self.abort_active_turn(&local_task_id).await {
            return Ok(json!({
                "success": false,
                "accepted": false,
                "taskId": local_task_id,
                "runtime": "codex",
                "error": "runtime task did not stop within timeout",
                "code": "cancel_timeout",
            }));
        }

        Ok(match link {
            Some(link) => task_action_success(&link),
            None => json!({
                "success": true,
                "accepted": true,
                "taskId": local_task_id,
                "runtime": "codex",
            }),
        })
    }

    fn resolve_pending_request_user_input_for_cancel(&self, local_task_id: &str) {
        let sender = self
            .active_request_user_inputs
            .lock()
            .ok()
            .and_then(|requests| requests.get(local_task_id).cloned());
        if let Some(sender) = sender {
            let _ = sender.try_send(empty_request_user_input_response());
        }
    }

    fn mark_task_running_for_send(
        &self,
        local_task_id: &str,
        thread_id: &str,
        workspace_path: &str,
        request: &ExecutionRequest,
        payload: &Value,
    ) {
        let message = cached_user_message(local_task_id, request, payload);
        let updated = self.store.update_task(local_task_id, |link| {
            link.thread_id = Some(thread_id.to_owned());
            link.workspace_path = workspace_path.to_owned();
            link.status = "running".to_owned();
            link.running = true;
            link.ephemeral = link.ephemeral || request.ephemeral;
            link.updated_at = now_ms();
            if let Some(message) = message.clone() {
                append_runtime_handle_message(&mut link.runtime_handle, message);
            }
        });
        if updated.is_some() {
            return;
        }

        let mut link = RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            workspace_path.to_owned(),
            prompt_text(&request.prompt),
        );
        link.thread_id = Some(thread_id.to_owned());
        link.ephemeral = request.ephemeral;
        if let Some(message) = message {
            set_runtime_handle_messages(&mut link.runtime_handle, vec![message]);
        }
        self.upsert_local_task(link);
    }

    fn trim_runtime_handle_after_rollback(&self, local_task_id: &str) {
        self.store.update_task(local_task_id, |link| {
            let mut messages = cached_messages(link);
            if let Some(index) = messages.iter().rposition(|message| {
                string_field(message, "role").is_some_and(|role| role.eq_ignore_ascii_case("user"))
            }) {
                messages.truncate(index);
                set_runtime_handle_messages(&mut link.runtime_handle, messages);
                link.updated_at = now_ms();
            }
        });
    }

    async fn open_workspace(&self, payload: Value) -> Result<Value, AppIpcError> {
        if !payload_runtime_is_codex(&payload) {
            return Ok(json!({
                "success": false,
                "error": "Only Codex runtime workspaces can be opened without a turn",
                "code": "unsupported_runtime",
            }));
        }
        let workspace_path = workspace_path(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let label = string_field(&payload, "label").or_else(|| string_field(&payload, "name"));
        let canonical = fs::canonicalize(&workspace_path).ok();
        if let Some(canonical) = canonical.as_ref() {
            if let Ok(mut roots) = self.opened_workspace_roots.lock() {
                roots.insert(canonical.clone());
            }
        }
        let project = match open_codex_global_project(&workspace_path, label.as_deref()) {
            Ok(project) => project,
            Err(error) => {
                if let Some(canonical) = canonical.as_ref() {
                    if let Ok(mut roots) = self.opened_workspace_roots.lock() {
                        roots.remove(canonical);
                    }
                }
                return Err(AppIpcError::new("codex_global_state_error", error));
            }
        };

        Ok(json!({
            "success": true,
            "accepted": true,
            "workspacePath": project.workspace_path,
            "runtime": "codex",
        }))
    }

    async fn rename_workspace(&self, payload: Value) -> Result<Value, AppIpcError> {
        if !payload_runtime_is_codex(&payload) {
            return Ok(json!({
                "success": false,
                "error": "Only Codex runtime workspaces can be renamed without a turn",
                "code": "unsupported_runtime",
            }));
        }
        let workspace_path = workspace_path(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let label = string_field(&payload, "label")
            .or_else(|| string_field(&payload, "name"))
            .ok_or_else(|| AppIpcError::new("bad_request", "label is required"))?;
        let project_key =
            string_field(&payload, "projectKey").or_else(|| string_field(&payload, "project_key"));
        let project = rename_codex_global_project(project_key.as_deref(), &workspace_path, &label)
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;

        Ok(json!({
            "success": true,
            "accepted": true,
            "workspacePath": project.workspace_path,
            "runtime": "codex",
        }))
    }

    async fn remove_workspace(&self, payload: Value) -> Result<Value, AppIpcError> {
        if !payload_runtime_is_codex(&payload) {
            return Ok(json!({
                "success": false,
                "error": "Only Codex runtime workspaces can be removed without a turn",
                "code": "unsupported_runtime",
            }));
        }
        let workspace_path = workspace_path(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let project_key =
            string_field(&payload, "projectKey").or_else(|| string_field(&payload, "project_key"));
        let workspace_path =
            remove_codex_global_project(project_key.as_deref(), &workspace_path)
                .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        if let Ok(canonical) = fs::canonicalize(&workspace_path) {
            if let Ok(mut roots) = self.opened_workspace_roots.lock() {
                roots.remove(&canonical);
            }
        }

        Ok(json!({
            "success": true,
            "accepted": true,
            "workspacePath": workspace_path,
            "runtime": "codex",
        }))
    }

    async fn reorder_sidebar_projects(&self, payload: Value) -> Result<Value, AppIpcError> {
        let project_key = string_field(&payload, "projectKey")
            .or_else(|| string_field(&payload, "project_key"))
            .ok_or_else(|| AppIpcError::new("bad_request", "projectKey is required"))?;
        let before_project_key = string_field(&payload, "beforeProjectKey")
            .or_else(|| string_field(&payload, "before_project_key"));
        let insert_at_end = bool_field(&payload, "insertAtEnd")
            .or_else(|| bool_field(&payload, "insert_at_end"))
            .unwrap_or(false);
        reorder_codex_global_projects(&project_key, before_project_key.as_deref(), insert_at_end)
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        Ok(sidebar_mutation_response(&self.device_id))
    }

    async fn pin_sidebar_project(&self, payload: Value) -> Result<Value, AppIpcError> {
        let project_key = string_field(&payload, "projectKey")
            .or_else(|| string_field(&payload, "project_key"))
            .ok_or_else(|| AppIpcError::new("bad_request", "projectKey is required"))?;
        let pinned = bool_field(&payload, "pinned")
            .ok_or_else(|| AppIpcError::new("bad_request", "pinned is required"))?;
        let before_project_key = string_field(&payload, "beforeProjectKey")
            .or_else(|| string_field(&payload, "before_project_key"));
        set_codex_global_project_pinned(&project_key, pinned, before_project_key.as_deref())
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        Ok(sidebar_mutation_response(&self.device_id))
    }

    async fn set_sidebar_project_appearance(&self, payload: Value) -> Result<Value, AppIpcError> {
        let project_key = string_field(&payload, "projectKey")
            .or_else(|| string_field(&payload, "project_key"))
            .ok_or_else(|| AppIpcError::new("bad_request", "projectKey is required"))?;
        let appearance = payload.get("appearance").cloned().filter(Value::is_object);
        set_codex_global_project_appearance(&project_key, appearance)
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        Ok(sidebar_mutation_response(&self.device_id))
    }

    async fn sync_sidebar_remote_projects(&self, payload: Value) -> Result<Value, AppIpcError> {
        let items = payload
            .get("projects")
            .and_then(Value::as_array)
            .ok_or_else(|| AppIpcError::new("bad_request", "projects is required"))?;
        let projects = items
            .iter()
            .map(|item| {
                Ok(CodexGlobalRemoteProject {
                    id: string_field(item, "id").ok_or_else(|| {
                        AppIpcError::new("bad_request", "remote project id is required")
                    })?,
                    host_id: string_field(item, "hostId")
                        .or_else(|| string_field(item, "host_id"))
                        .ok_or_else(|| {
                            AppIpcError::new("bad_request", "remote project hostId is required")
                        })?,
                    remote_path: string_field(item, "remotePath")
                        .or_else(|| string_field(item, "remote_path"))
                        .ok_or_else(|| {
                            AppIpcError::new("bad_request", "remote project remotePath is required")
                        })?,
                    label: string_field(item, "label"),
                })
            })
            .collect::<Result<Vec<_>, AppIpcError>>()?;
        sync_codex_global_remote_projects(&projects)
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        Ok(sidebar_mutation_response(&self.device_id))
    }

    async fn activate_sidebar_project(&self, payload: Value) -> Result<Value, AppIpcError> {
        let project_key = string_field(&payload, "projectKey")
            .or_else(|| string_field(&payload, "project_key"))
            .ok_or_else(|| AppIpcError::new("bad_request", "projectKey is required"))?;
        let workspace_path = workspace_path(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let remote_host_id = string_field(&payload, "remoteHostId")
            .or_else(|| string_field(&payload, "remote_host_id"));
        activate_codex_global_project(&project_key, &workspace_path, remote_host_id.as_deref())
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        Ok(sidebar_mutation_response(&self.device_id))
    }

    async fn reorder_sidebar_project_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let project_key = string_field(&payload, "projectKey")
            .or_else(|| string_field(&payload, "project_key"))
            .ok_or_else(|| AppIpcError::new("bad_request", "projectKey is required"))?;
        let thread_id = string_field(&payload, "threadId")
            .or_else(|| string_field(&payload, "thread_id"))
            .ok_or_else(|| AppIpcError::new("bad_request", "threadId is required"))?;
        let before_thread_id = string_field(&payload, "beforeThreadId")
            .or_else(|| string_field(&payload, "before_thread_id"));
        let insert_at_end = bool_field(&payload, "insertAtEnd")
            .or_else(|| bool_field(&payload, "insert_at_end"))
            .unwrap_or(false);
        reorder_codex_global_project_thread(
            &project_key,
            &thread_id,
            before_thread_id.as_deref(),
            insert_at_end,
        )
        .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        Ok(sidebar_mutation_response(&self.device_id))
    }

    async fn pin_sidebar_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let thread_id = string_field(&payload, "threadId")
            .or_else(|| string_field(&payload, "thread_id"))
            .ok_or_else(|| AppIpcError::new("bad_request", "threadId is required"))?;
        let pinned = bool_field(&payload, "pinned")
            .ok_or_else(|| AppIpcError::new("bad_request", "pinned is required"))?;
        let before_thread_id = string_field(&payload, "beforeThreadId")
            .or_else(|| string_field(&payload, "before_thread_id"));
        set_codex_global_thread_pinned(&thread_id, pinned, before_thread_id.as_deref())
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        Ok(sidebar_mutation_response(&self.device_id))
    }

    async fn prepare_fork_transfer(&self, payload: Value) -> Result<Value, AppIpcError> {
        let transfer = match super::fork_transfer::validate_prepare_transfer_payload(&payload) {
            Ok(transfer) => transfer,
            Err(error) => return Ok(fork_error_response(error.code(), error.to_string())),
        };
        let workspace_path = workspace_path(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let link = self.task_link_from_payload(&payload, false).await?;
        let include_workspace = transfer.workspace_transfer.as_deref() == Some("git_workspace");
        let mut archive = Map::new();
        archive.insert(
            "mode".to_owned(),
            Value::String(
                if include_workspace {
                    "git_workspace"
                } else {
                    "session_only"
                }
                .to_owned(),
            ),
        );
        archive.insert("transferId".to_owned(), Value::String(transfer.transfer_id));
        archive.insert(
            "requiresWorkspaceRestore".to_owned(),
            Value::Bool(include_workspace),
        );
        archive.insert("directUrls".to_owned(), Value::Array(Vec::new()));

        Ok(json!({
            "success": true,
            "accepted": true,
            "workspacePath": workspace_path,
            "taskId": link.local_task_id,
            "package": {
                "sourceRuntime": link.runtime,
                "title": link.title,
                "runtimeHandle": runtime_handle_json(&link),
                "recentMessages": cached_messages(&link),
                "archive": Value::Object(archive),
            }
        }))
    }

    async fn import_fork(&self, payload: Value) -> Result<Value, AppIpcError> {
        let import = match super::fork_transfer::validate_import_fork_payload(&payload) {
            Ok(import) => import,
            Err(error) => return Ok(fork_error_response(error.code(), error.to_string())),
        };
        let runtime = string_field(&import.fork_package, "sourceRuntime")
            .or_else(|| string_field(&import.fork_package, "source_runtime"))
            .unwrap_or_else(|| "codex".to_owned());
        if runtime.eq_ignore_ascii_case("codex") {
            return Ok(json!({
                "success": false,
                "error": "Codex fork imports must restore into native Codex, not runtime index",
                "code": "bad_request",
            }));
        }
        let runtime_handle =
            match super::fork_transfer::build_imported_runtime_handle(&import.fork_package) {
                Ok(runtime_handle) => runtime_handle,
                Err(error) => return Ok(fork_error_response(error.code(), error.to_string())),
            };
        let local_task_id = format!("runtime-fork-{}", now_ms());
        let title = string_field(&import.fork_package, "title")
            .unwrap_or_else(|| "Forked runtime task".to_owned());
        let parent = source_parent_json(&import.source);
        let link = RuntimeTaskLink::new_imported(
            local_task_id.clone(),
            import.workspace_path,
            title,
            runtime,
            runtime_handle,
            parent,
        );
        self.upsert_local_task(link.clone());
        Ok(task_action_success(&link))
    }

    fn spawn_turn(&self, turn: SpawnTurnRequest) {
        let SpawnTurnRequest {
            local_task_id,
            request,
            direct_thread_id,
            fork_thread_id,
            fork_thread_path,
            resume_thread_id,
            initial_thread_name,
            initial_thread_goal,
        } = turn;
        let mut fields = task_fields(&request.task_id, &request.subtask_id);
        fields.push(("local_task_id", local_task_id.clone()));
        fields.push(("direct", direct_thread_id.is_some().to_string()));
        fields.push(("fork", fork_thread_id.is_some().to_string()));
        fields.push(("resume", resume_thread_id.is_some().to_string()));
        if let Some(thread_id) = &direct_thread_id {
            fields.push(("direct_thread_id", thread_id.clone()));
        }
        if let Some(thread_id) = &fork_thread_id {
            fields.push(("fork_thread_id", thread_id.clone()));
        }
        if let Some(path) = &fork_thread_path {
            fields.push(("fork_thread_path", path.clone()));
        }
        if let Some(thread_id) = &resume_thread_id {
            fields.push(("thread_id", thread_id.clone()));
        }
        if let Some(cwd) = request.cwd() {
            fields.push(("cwd", cwd.to_owned()));
        }
        log_executor_event("runtime work turn spawning", &fields);

        self.mark_active_local_task(&local_task_id);
        let (request_user_input_tx, request_user_input_rx): (
            mpsc::Sender<Value>,
            CodexRequestUserInputReceiver,
        ) = mpsc::channel(1);
        if let Ok(mut requests) = self.active_request_user_inputs.lock() {
            requests.insert(local_task_id.clone(), request_user_input_tx);
        }
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (stopped_tx, stopped_rx) = oneshot::channel();
        self.set_active_turn_cancellation(
            local_task_id.clone(),
            ActiveTurnCancellation {
                cancel: cancel_tx,
                stopped: stopped_rx,
            },
        );
        let handler = self.clone();
        let turn_local_task_id = local_task_id.clone();
        let turn_handle = tokio::spawn(async move {
            emit_response_event(
                &handler.event_tx,
                &handler.device_id,
                "response.created",
                &turn_local_task_id,
                &request,
                json!({"response": {"status": "in_progress"}}),
            );

            handler.ensure_notification_router().await;
            let (notification_tx, mut notification_rx) = mpsc::unbounded_channel::<Value>();
            let mapper_handler = handler.clone();
            let mapper_local_task_id = turn_local_task_id.clone();
            let mapper_request = request.clone();
            let mapper_handle = tokio::spawn(async move {
                let mut event_mapper = CodexNotificationEventMapper::default();
                while let Some(message) = notification_rx.recv().await {
                    mapper_handler
                        .sync_runtime_task_goal_from_notification(&mapper_local_task_id, &message);
                    event_mapper.map(
                        &mapper_handler.event_tx,
                        &mapper_handler.device_id,
                        &mapper_local_task_id,
                        &mapper_request,
                        message,
                    );
                }
            });
            let route_handler = handler.clone();
            let route_local_task_id = turn_local_task_id.clone();
            let thread_started: CodexThreadStartedCallback = Box::new(move |thread_id| {
                route_handler.record_local_task_thread(&route_local_task_id, &thread_id);
            });
            let active_turn_handler = handler.clone();
            let active_turn_local_task_id = turn_local_task_id.clone();
            let active_turn_started: CodexActiveTurnCallback =
                Box::new(move |thread_id, turn_id| {
                    active_turn_handler.record_active_codex_turn(
                        &active_turn_local_task_id,
                        thread_id,
                        turn_id,
                    );
                });
            let finished_turn_handler = handler.clone();
            let finished_turn_local_task_id = turn_local_task_id.clone();
            let active_turn_finished: CodexActiveTurnFinishedCallback = Box::new(move || {
                finished_turn_handler.clear_active_codex_turn(&finished_turn_local_task_id);
            });
            let result = handler
                .codex_app_server
                .run_turn_with_cancel(
                    request.clone(),
                    CodexAppServerTurnOptions {
                        direct_thread_id,
                        fork_thread_id,
                        fork_thread_path,
                        resume_thread_id,
                        initial_thread_name,
                        initial_thread_goal,
                        notifications: Some(notification_tx),
                        cancellation: Some(cancel_rx),
                        request_user_input_answers: Some(request_user_input_rx),
                        thread_started: Some(thread_started),
                        active_turn_started: Some(active_turn_started),
                        active_turn_finished: Some(active_turn_finished),
                    },
                )
                .await;

            if matches!(result.as_ref(), Err(error) if error == CODEX_APP_SERVER_TURN_CANCELLED) {
                emit_response_event(
                    &handler.event_tx,
                    &handler.device_id,
                    "response.incomplete",
                    &turn_local_task_id,
                    &request,
                    json!({
                        "type": "cancelled",
                        "error": {"message": "cancelled"},
                    }),
                );
                let _ = mapper_handle.await;
                handler.clear_active_turn_cancellation(&turn_local_task_id);
                handler.clear_active_codex_turn(&turn_local_task_id);
                handler.unmark_active_local_task(&turn_local_task_id);
                handler.mark_thread_event_routes_idle_for_local_task(&turn_local_task_id);
                if let Ok(mut requests) = handler.active_request_user_inputs.lock() {
                    requests.remove(&turn_local_task_id);
                }
                let _ = stopped_tx.send(());
                return;
            }

            let _ = mapper_handle.await;
            handler.handle_turn_result(&turn_local_task_id, &request, result);
            handler.clear_active_codex_turn(&turn_local_task_id);
            if let Ok(mut requests) = handler.active_request_user_inputs.lock() {
                requests.remove(&turn_local_task_id);
            }
            let _ = stopped_tx.send(());
        });
        drop(turn_handle);
    }

    fn handle_turn_result(
        &self,
        local_task_id: &str,
        request: &ExecutionRequest,
        result: Result<crate::agents::CodexAppServerTurn, String>,
    ) {
        match result {
            Ok(turn) => {
                let status = match &turn.outcome {
                    ExecutionOutcome::Completed { .. } => "done",
                    ExecutionOutcome::WaitingForUserInput { .. } => "done",
                    ExecutionOutcome::Cancelled { .. } => "cancelled",
                    ExecutionOutcome::Failed { .. } => "failed",
                    ExecutionOutcome::Running => "running",
                };
                let thread_id = turn.thread_id.clone();
                self.register_thread_event_route(
                    &thread_id,
                    local_task_id.to_owned(),
                    request.clone(),
                    false,
                );
                self.finish_local_task(local_task_id, Some(thread_id.clone()), status);
                self.mark_thread_event_route_idle(&thread_id);
                self.register_codex_thread_workspace_root(&thread_id, request);
                match turn.outcome {
                    ExecutionOutcome::Completed { content } => emit_response_event(
                        &self.event_tx,
                        &self.device_id,
                        "response.completed",
                        local_task_id,
                        request,
                        json!({"value": content}),
                    ),
                    ExecutionOutcome::WaitingForUserInput { stop_reason } => emit_response_event(
                        &self.event_tx,
                        &self.device_id,
                        "response.completed",
                        local_task_id,
                        request,
                        json!({
                            "value": "",
                            "stop_reason": stop_reason,
                            "silent_exit": true,
                            "silent_exit_reason": "waiting_for_user_input"
                        }),
                    ),
                    ExecutionOutcome::Cancelled { message } => emit_response_event(
                        &self.event_tx,
                        &self.device_id,
                        "response.incomplete",
                        local_task_id,
                        request,
                        json!({"error": {"message": message}}),
                    ),
                    ExecutionOutcome::Failed { message } => {
                        let mut fields = task_fields(&request.task_id, &request.subtask_id);
                        fields.push(("local_task_id", local_task_id.to_owned()));
                        fields.push(("error", message.clone()));
                        fields.push(("error_len", message.len().to_string()));
                        log_executor_event("runtime work turn failed", &fields);
                        emit_response_event(
                            &self.event_tx,
                            &self.device_id,
                            "response.failed",
                            local_task_id,
                            request,
                            json!({"error": {"message": message}}),
                        );
                    }
                    ExecutionOutcome::Running => {}
                }
            }
            Err(error) => {
                self.mark_thread_event_routes_idle_for_local_task(local_task_id);
                self.finish_local_task(local_task_id, None, "failed");
                let mut fields = task_fields(&request.task_id, &request.subtask_id);
                fields.push(("local_task_id", local_task_id.to_owned()));
                fields.push(("error", error.clone()));
                fields.push(("error_len", error.len().to_string()));
                log_executor_event("runtime work turn failed", &fields);
                emit_response_event(
                    &self.event_tx,
                    &self.device_id,
                    "response.failed",
                    local_task_id,
                    request,
                    json!({"error": {"message": error}}),
                );
            }
        }
    }

    fn register_codex_thread_workspace_root(&self, thread_id: &str, request: &ExecutionRequest) {
        let Some(workspace_path) = request.cwd() else {
            return;
        };
        if infer_workspace_kind(workspace_path) == "chat" {
            return;
        }
        match register_codex_global_thread_workspace_root(thread_id, workspace_path) {
            Ok(Some(workspace_root)) => {
                log_executor_event(
                    "runtime work codex thread workspace root registered",
                    &[
                        ("thread_id", thread_id.to_owned()),
                        ("workspace_root", workspace_root),
                    ],
                );
            }
            Ok(None) => {}
            Err(error) => {
                log_executor_event(
                    "runtime work codex thread workspace root registration failed",
                    &[("thread_id", thread_id.to_owned()), ("error", error)],
                );
            }
        }
    }

    async fn ensure_notification_router(&self) {
        if self
            .notification_router
            .lock()
            .expect("notification router lock should not be poisoned")
            .as_ref()
            .is_some_and(|task| !task.is_finished())
        {
            return;
        }

        let notification_rx = match self.codex_app_server.subscribe_notifications().await {
            Ok(receiver) => receiver,
            Err(error) => {
                log_executor_event(
                    "runtime work notification router subscribe failed",
                    &[("error", error)],
                );
                return;
            }
        };

        let mut router = self
            .notification_router
            .lock()
            .expect("notification router lock should not be poisoned");
        if router.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }

        let handler = self.clone();
        *router = Some(tokio::spawn(async move {
            handler.run_notification_router(notification_rx).await;
        }));
    }

    async fn run_notification_router(&self, mut notification_rx: broadcast::Receiver<Value>) {
        loop {
            let message = match notification_rx.recv().await {
                Ok(message) => message,
                Err(broadcast::error::RecvError::Lagged(count)) => {
                    log_executor_event(
                        "runtime work notification router lagged",
                        &[("count", count.to_string())],
                    );
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    log_executor_event("runtime work notification router closed", &[]);
                    return;
                }
            };

            if message.get("method").and_then(Value::as_str) == Some("codex/app-server/exited") {
                log_executor_event("runtime work notification router app-server exited", &[]);
                return;
            }

            self.route_codex_notification(message);
        }
    }

    fn route_codex_notification(&self, message: Value) {
        let thread_id =
            codex_notification_thread_id(&message).or_else(|| self.unscoped_route_thread_id());
        let Some(thread_id) = thread_id else {
            debug_unrouted_codex_notification(&message, "missing_thread_id");
            return;
        };

        if !self.thread_event_route_exists(&thread_id) {
            self.register_thread_event_route_from_store(&thread_id);
        }
        if !self.thread_event_route_exists(&thread_id)
            && codex_started_thread_id(&message).as_deref() == Some(thread_id.as_str())
        {
            self.promote_pending_thread_event_route(&thread_id);
        }

        let mut routes = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned");
        let Some(route) = routes.get_mut(&thread_id) else {
            debug_unrouted_codex_notification(&message, "missing_route");
            return;
        };
        if self.is_active_local_task(&route.local_task_id) {
            return;
        }
        if let Some(started_thread_id) = codex_started_thread_id(&message) {
            self.register_codex_thread_workspace_root(&started_thread_id, &route.request);
        }
        route.event_mapper.map(
            &self.event_tx,
            &self.device_id,
            &route.local_task_id,
            &route.request,
            message,
        );
    }

    fn register_thread_event_route(
        &self,
        thread_id: &str,
        local_task_id: String,
        request: ExecutionRequest,
        active: bool,
    ) {
        if thread_id.trim().is_empty() {
            return;
        }
        self.store.update_task(&local_task_id, |link| {
            link.thread_id = Some(thread_id.to_owned());
            link.updated_at = now_ms();
        });
        let pending_id = pending_thread_event_route_id(&local_task_id);
        let mut routes = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned");
        let existing = routes
            .remove(thread_id)
            .or_else(|| routes.remove(&pending_id));
        let mut route = existing.unwrap_or_else(|| {
            RuntimeThreadEventRoute::new(local_task_id.clone(), request.clone(), active)
        });
        if active {
            route.event_mapper = CodexNotificationEventMapper::default();
        }
        route.local_task_id = local_task_id;
        route.request = request;
        route.active = route.active || active;
        routes.insert(thread_id.to_owned(), route);
    }

    #[cfg(test)]
    fn register_pending_thread_event_route(
        &self,
        local_task_id: String,
        request: ExecutionRequest,
    ) {
        let pending_id = pending_thread_event_route_id(&local_task_id);
        let mut routes = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned");
        if let Some(route) = routes.get_mut(&pending_id) {
            route.request = request;
            route.active = true;
            return;
        }
        routes.insert(
            pending_id,
            RuntimeThreadEventRoute::new(local_task_id, request, true),
        );
    }

    fn record_local_task_thread(&self, local_task_id: &str, thread_id: &str) {
        if thread_id.trim().is_empty() {
            return;
        }
        self.store.update_task(local_task_id, |link| {
            link.thread_id = Some(thread_id.to_owned());
            link.updated_at = now_ms();
        });
    }

    fn register_thread_event_route_for_link(&self, link: &RuntimeTaskLink, active: bool) {
        let Some(thread_id) = runtime_session_id_from_link(link) else {
            return;
        };
        self.register_thread_event_route(
            &thread_id,
            link.local_task_id.clone(),
            runtime_event_request_from_link(link),
            active,
        );
    }

    fn register_thread_event_route_from_store(&self, thread_id: &str) {
        if let Some(link) = self.local_task_by_thread_id(thread_id) {
            self.register_thread_event_route_for_link(&link, false);
        }
    }

    fn thread_event_route_exists(&self, thread_id: &str) -> bool {
        self.thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned")
            .contains_key(thread_id)
    }

    fn promote_pending_thread_event_route(&self, thread_id: &str) -> bool {
        if thread_id.trim().is_empty() {
            return false;
        }

        let mut routes = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned");
        if routes.contains_key(thread_id) {
            return true;
        }
        let mut pending_route_ids = routes
            .iter()
            .filter(|(route_id, route)| is_pending_thread_event_route_id(route_id) && route.active)
            .map(|(route_id, _)| route_id.clone());
        let Some(pending_route_id) = pending_route_ids.next() else {
            return false;
        };
        if pending_route_ids.next().is_some() {
            return false;
        }
        let Some(route) = routes.remove(&pending_route_id) else {
            return false;
        };
        let local_task_id = route.local_task_id.clone();
        routes.insert(thread_id.to_owned(), route);
        drop(routes);

        self.store.update_task(&local_task_id, |link| {
            link.thread_id = Some(thread_id.to_owned());
            link.updated_at = now_ms();
        });
        true
    }

    fn unscoped_route_thread_id(&self) -> Option<String> {
        let routes = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned");
        let mut active_routes = routes
            .iter()
            .filter(|(_, route)| route.active)
            .map(|(thread_id, _)| thread_id.clone());
        if let Some(thread_id) = active_routes.next() {
            if active_routes.next().is_some() {
                return None;
            }
            return Some(thread_id);
        }

        let mut route_ids = routes.keys().cloned();
        let thread_id = route_ids.next()?;
        if route_ids.next().is_some() {
            None
        } else {
            Some(thread_id)
        }
    }

    fn mark_thread_event_route_idle(&self, thread_id: &str) {
        if let Some(route) = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned")
            .get_mut(thread_id)
        {
            route.active = false;
        }
    }

    fn remove_thread_event_route(&self, thread_id: &str) {
        self.thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned")
            .remove(thread_id);
    }

    fn mark_thread_event_routes_idle_for_local_task(&self, local_task_id: &str) {
        for route in self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned")
            .values_mut()
        {
            if route.local_task_id == local_task_id {
                route.active = false;
            }
        }
    }

    async fn collect_links(&self, archived: bool) -> Vec<RuntimeTaskLink> {
        let started_at = Instant::now();
        let mut links = Vec::new();
        let mut discovered_thread_ids = HashSet::new();
        let mut discovered_local_task_ids = HashSet::new();
        let mut discovered_codex_task_signatures = HashSet::new();

        let threads = self.codex_threads(archived).await;
        let stage_started_at = Instant::now();
        for thread in threads {
            let thread_started_at = Instant::now();
            let thread_id = string_field(&thread, "id").unwrap_or_else(|| "none".to_owned());
            if let Some(mut link) = self.link_from_thread(&thread) {
                log_slow_runtime_collect_thread(
                    archived,
                    &thread_id,
                    thread_started_at,
                    &thread,
                    &link,
                );
                if link.ephemeral {
                    continue;
                }
                if self.archived_link_is_deleted(&link) {
                    log_executor_event(
                        "runtime work codex link hidden by deleted marker",
                        &[
                            ("archived_query", archived.to_string()),
                            ("local_task_id", link.local_task_id.clone()),
                            (
                                "thread_id",
                                link.thread_id.as_deref().unwrap_or("none").to_owned(),
                            ),
                            ("workspace_path", link.workspace_path.clone()),
                        ],
                    );
                    continue;
                }
                if archived {
                    link.status = "archived".to_owned();
                    link.running = false;
                } else if link.status == "archived" {
                    continue;
                }
                link.list_order = Some(links.len());
                if let Some(thread_id) = &link.thread_id {
                    discovered_thread_ids.insert(thread_id.clone());
                }
                discovered_local_task_ids.insert(link.local_task_id.clone());
                if let Some(signature) = codex_task_signature(&link) {
                    discovered_codex_task_signatures.insert(signature);
                }
                links.push(link);
            } else {
                log_slow_runtime_collect_thread_missing(
                    archived,
                    &thread_id,
                    thread_started_at,
                    &thread,
                );
            }
        }
        log_runtime_collect_diagnostic(
            "threads_linked",
            archived,
            started_at,
            stage_started_at,
            &[
                ("links", links.len().to_string()),
                ("threads", discovered_thread_ids.len().to_string()),
            ],
        );

        let stage_started_at = Instant::now();
        for mut link in self.local_task_links(true) {
            if self.archived_link_is_deleted(&link) {
                continue;
            }
            if link.ephemeral {
                continue;
            }
            let link_archived = link.status == "archived";
            if link_archived != archived {
                continue;
            }
            if is_cached_codex_link_hidden(&link, &discovered_thread_ids) {
                continue;
            }
            if discovered_local_task_ids.contains(&link.local_task_id) {
                continue;
            }
            if link
                .thread_id
                .as_ref()
                .is_some_and(|thread_id| discovered_thread_ids.contains(thread_id))
            {
                continue;
            }
            if is_unmapped_pending_codex_shadow(&link, &discovered_codex_task_signatures) {
                continue;
            }
            if !self.is_active_local_task(&link.local_task_id)
                && normalize_inactive_running_codex_task(&mut link)
            {
                self.store.upsert_task(link.clone());
            }
            link.list_order = Some(links.len());
            links.push(link);
        }
        log_runtime_collect_diagnostic(
            "local_links_merged",
            archived,
            started_at,
            stage_started_at,
            &[("links", links.len().to_string())],
        );

        links
    }

    async fn codex_threads(&self, archived: bool) -> Vec<Value> {
        let started_at = Instant::now();
        let mut threads = Vec::new();
        let mut cursor = None;
        let mut pages = 0_usize;
        self.ensure_notification_router().await;
        loop {
            let params = codex_thread_list_params(archived, cursor.as_deref());
            let response = match self.codex_app_server.request("thread/list", params).await {
                Ok(response) => response,
                Err(error) => {
                    log_executor_event(
                        "runtime work thread list failed",
                        &[
                            ("elapsed_ms", elapsed_ms(started_at)),
                            ("archived", archived.to_string()),
                            ("threads", threads.len().to_string()),
                            ("pages", pages.to_string()),
                            ("error", error),
                        ],
                    );
                    break;
                }
            };
            let Some(data) = response.get("data").and_then(Value::as_array) else {
                log_executor_event(
                    "runtime work thread list malformed",
                    &[
                        ("elapsed_ms", elapsed_ms(started_at)),
                        ("archived", archived.to_string()),
                        ("threads", threads.len().to_string()),
                        ("pages", pages.to_string()),
                        ("error", "missing data array".to_owned()),
                    ],
                );
                break;
            };
            pages += 1;
            threads.extend(data.iter().cloned());
            cursor = string_field(&response, "nextCursor");
            if cursor.is_none() || threads.len() >= CODEX_THREAD_LIST_MAX_ITEMS {
                break;
            }
        }

        if threads.len() > CODEX_THREAD_LIST_MAX_ITEMS {
            threads.truncate(CODEX_THREAD_LIST_MAX_ITEMS);
        }
        log_executor_event(
            "runtime work thread list fetched",
            &[
                ("elapsed_ms", elapsed_ms(started_at)),
                ("archived", archived.to_string()),
                ("threads", threads.len().to_string()),
                ("pages", pages.to_string()),
                (
                    "truncated",
                    (threads.len() >= CODEX_THREAD_LIST_MAX_ITEMS).to_string(),
                ),
            ],
        );
        threads
    }

    async fn thread_path_for_id(&self, thread_id: &str) -> Option<String> {
        for thread in self.codex_threads(false).await {
            if string_field(&thread, "id").as_deref() == Some(thread_id) {
                return string_field(&thread, "path").filter(|path| !path.trim().is_empty());
            }
        }
        None
    }

    fn visible_links_for_projects(
        &self,
        links: Vec<RuntimeTaskLink>,
        project_index: &CodexGlobalProjectIndex,
    ) -> Vec<RuntimeTaskLink> {
        let links = links
            .into_iter()
            .map(|mut link| {
                if !is_codex_runtime(&link.runtime) {
                    return link;
                }

                if let Some(thread_id) = link.thread_id.as_deref() {
                    link.pinned = project_index.is_pinned_thread(thread_id);
                    link.pinned_order = project_index.pinned_thread_order(thread_id);
                    if infer_workspace_kind(&link.workspace_path) == "chat" {
                        link.list_order = Some(project_index.thread_sort_order(
                            "chats",
                            thread_id,
                            link.list_order.unwrap_or(usize::MAX / 2),
                        ));
                    }
                }
                link
            })
            .collect::<Vec<_>>();
        let input_count = links.len();
        let project_count = project_index.projects().len();
        let project_roots = project_index
            .projects()
            .iter()
            .map(|project| project.workspace_path.as_str())
            .collect::<Vec<_>>()
            .join("|");

        if !project_index.has_projects() && !project_index.has_project_state() {
            log_executor_event(
                "runtime work project filter skipped",
                &[
                    ("reason", "no_project_state".to_owned()),
                    ("input_links", input_count.to_string()),
                    ("project_count", project_count.to_string()),
                    (
                        "project_state_loaded",
                        project_index.has_project_state().to_string(),
                    ),
                ],
            );
            return links;
        }

        let mut visible_links = Vec::with_capacity(input_count);
        let mut kept_non_codex = 0_usize;
        let mut kept_chat = 0_usize;
        let mut kept_project = 0_usize;
        let mut filtered_projectless = 0_usize;
        let mut filtered_no_project = 0_usize;

        for mut link in links {
            if !is_codex_runtime(&link.runtime) {
                kept_non_codex += 1;
                log_runtime_project_filter_item(
                    &link,
                    RuntimeProjectFilterLog {
                        action: "keep",
                        reason: "non_codex_runtime",
                        workspace_kind: infer_workspace_kind(&link.workspace_path),
                        group_path: None,
                        matched_by: None,
                        project_workspace_path: None,
                        project_name: None,
                        thread_hint: None,
                        project_count,
                    },
                );
                visible_links.push(link);
                continue;
            }

            let workspace_kind = infer_workspace_kind(&link.workspace_path);
            if workspace_kind == "chat" {
                kept_chat += 1;
                log_runtime_project_filter_item(
                    &link,
                    RuntimeProjectFilterLog {
                        action: "keep",
                        reason: "chat_workspace",
                        workspace_kind,
                        group_path: None,
                        matched_by: None,
                        project_workspace_path: None,
                        project_name: None,
                        thread_hint: None,
                        project_count,
                    },
                );
                visible_links.push(link);
                continue;
            }

            let group_path = self
                .worktrees
                .source_path_for(&link.workspace_path)
                .unwrap_or_else(|| workspace_group_path(&link.workspace_path));
            let thread_id = link.thread_id.as_deref();
            let thread_hint = thread_id.and_then(|id| project_index.thread_workspace_hint(id));
            if thread_id.is_some_and(|id| project_index.is_projectless_thread(id)) {
                filtered_projectless += 1;
                log_runtime_project_filter_item(
                    &link,
                    RuntimeProjectFilterLog {
                        action: "filter",
                        reason: "projectless_thread",
                        workspace_kind,
                        group_path: Some(&group_path),
                        matched_by: None,
                        project_workspace_path: None,
                        project_name: None,
                        thread_hint,
                        project_count,
                    },
                );
                continue;
            }

            let direct_project = project_index.project_for_thread(thread_id, &link.workspace_path);
            let group_project = if direct_project.is_none() {
                project_index.project_for_thread(thread_id, &group_path)
            } else {
                None
            };
            let project = direct_project.or(group_project);

            let Some(project) = project else {
                filtered_no_project += 1;
                log_runtime_project_filter_item(
                    &link,
                    RuntimeProjectFilterLog {
                        action: "filter",
                        reason: "no_matching_project",
                        workspace_kind,
                        group_path: Some(&group_path),
                        matched_by: None,
                        project_workspace_path: None,
                        project_name: None,
                        thread_hint,
                        project_count,
                    },
                );
                continue;
            };

            let matched_by = if let Some(hinted_root) = thread_hint {
                if project_index
                    .project_for_key(hinted_root)
                    .is_some_and(|hinted_project| {
                        hinted_project.workspace_path == project.workspace_path
                    })
                {
                    "thread_hint"
                } else if direct_project.is_some() {
                    "workspace_path"
                } else {
                    "group_path"
                }
            } else if direct_project.is_some() {
                "workspace_path"
            } else {
                "group_path"
            };
            let project_workspace_path = project.workspace_path.clone();
            let project_key = project.key.clone();
            let project_name = project.name.clone();
            link.group_workspace_path = Some(project_workspace_path.clone());
            link.group_project_key = Some(project_key.clone());
            if let Some(thread_id) = link.thread_id.as_deref() {
                link.list_order = Some(project_index.thread_sort_order(
                    &project_key,
                    thread_id,
                    link.list_order.unwrap_or(usize::MAX / 2),
                ));
            }
            kept_project += 1;
            log_runtime_project_filter_item(
                &link,
                RuntimeProjectFilterLog {
                    action: "keep",
                    reason: "matched_project",
                    workspace_kind,
                    group_path: Some(&group_path),
                    matched_by: Some(matched_by),
                    project_workspace_path: Some(&project_workspace_path),
                    project_name: Some(&project_name),
                    thread_hint,
                    project_count,
                },
            );
            visible_links.push(link);
        }

        log_executor_event(
            "runtime work project filter finished",
            &[
                ("input_links", input_count.to_string()),
                ("visible_links", visible_links.len().to_string()),
                (
                    "filtered_links",
                    (filtered_projectless + filtered_no_project).to_string(),
                ),
                ("project_count", project_count.to_string()),
                (
                    "project_state_loaded",
                    project_index.has_project_state().to_string(),
                ),
                ("project_roots", project_roots),
                ("kept_non_codex", kept_non_codex.to_string()),
                ("kept_chat", kept_chat.to_string()),
                ("kept_project", kept_project.to_string()),
                ("filtered_projectless", filtered_projectless.to_string()),
                ("filtered_no_project", filtered_no_project.to_string()),
            ],
        );

        visible_links
    }

    async fn task_link_from_payload(
        &self,
        payload: &Value,
        archived: bool,
    ) -> Result<RuntimeTaskLink, AppIpcError> {
        let local_task_id = runtime_task_id(payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        if let Some(link) = self.local_task_link(&local_task_id) {
            if (link.status == "archived") == archived {
                log_runtime_archive_link(
                    "runtime task payload matched local link",
                    &link,
                    archived,
                );
                return Ok(link);
            }
            log_runtime_archive_link(
                "runtime task payload skipped local link status mismatch",
                &link,
                archived,
            );
        }

        for link in self.collect_links(archived).await {
            if link.local_task_id == local_task_id
                || link.thread_id.as_deref() == Some(local_task_id.as_str())
            {
                log_runtime_archive_link(
                    "runtime task payload matched collected link",
                    &link,
                    archived,
                );
                return Ok(link);
            }
        }

        let workspace_path = workspace_path(payload)
            .ok_or_else(|| AppIpcError::new("not_found", "runtime task was not found"))?;
        // A local task ID identifies Wework's persisted task record; it is not a
        // Codex thread ID. Keep this unresolved until a provider thread is known.
        let mut link =
            RuntimeTaskLink::new_pending(local_task_id.clone(), workspace_path, local_task_id);
        link.status = if archived { "archived" } else { "active" }.to_owned();
        link.running = false;
        log_runtime_archive_link("runtime task payload created pending link", &link, archived);
        Ok(link)
    }

    async fn recover_send_task_link(
        &self,
        payload: &Value,
        local_task_id: &str,
        existing_link: Option<&RuntimeTaskLink>,
    ) -> Option<RuntimeTaskLink> {
        if existing_link
            .and_then(runtime_session_id_from_link)
            .is_some()
        {
            return existing_link.cloned();
        }

        let workspace_path = workspace_path(payload).unwrap_or_default();
        let mut workspace_matches = Vec::new();
        for link in self.collect_links(false).await {
            if link.local_task_id == local_task_id
                || link.thread_id.as_deref() == Some(local_task_id)
            {
                return Some(link);
            }

            if !workspace_path.is_empty()
                && link.workspace_path == workspace_path
                && runtime_session_id_from_link(&link).is_some()
            {
                workspace_matches.push(link);
            }
        }

        if workspace_matches.len() == 1 {
            workspace_matches.pop()
        } else {
            None
        }
    }

    async fn thread_messages(&self, thread_id: &str) -> Vec<Value> {
        match self
            .codex_app_server
            .request(
                "thread/read",
                json!({"threadId": thread_id, "includeTurns": true}),
            )
            .await
        {
            Ok(response) => {
                let thread = response.get("thread").unwrap_or(&response);
                transcript_messages(thread, &self.device_id)
            }
            Err(error) => {
                eprintln!("failed to read Codex app-server thread {thread_id}: {error}");
                Vec::new()
            }
        }
    }

    async fn call_codex_thread_method(&self, method: &str, params: Value) -> Result<Value, String> {
        let result = self
            .call_codex_thread_method_without_list_invalidation(method, params)
            .await;
        result
    }

    async fn call_codex_thread_method_without_list_invalidation(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        if let Some(thread_id) = codex_stream_thread_id(&params) {
            self.register_thread_event_route_from_store(&thread_id);
        }
        self.ensure_notification_router().await;
        self.codex_app_server.request(method, params).await
    }

    fn link_from_thread(&self, thread: &Value) -> Option<RuntimeTaskLink> {
        let thread_id = string_field(thread, "id")?;
        let mut local_link = self.local_task_by_thread_id(&thread_id);
        let local_active = local_link
            .as_ref()
            .is_some_and(|link| self.is_active_local_task(&link.local_task_id));
        if let Some(link) = &mut local_link {
            if !local_active && normalize_inactive_running_codex_task(link) {
                self.store.upsert_task(link.clone());
            }
        }
        let workspace_path = string_field(thread, "cwd")
            .or_else(|| local_link.as_ref().map(|link| link.workspace_path.clone()))
            .unwrap_or_else(|| "~/.codex".to_owned());
        let mut link = RuntimeTaskLink::from_thread_metadata(thread, local_link, workspace_path);
        if let Some(path) = string_field(thread, "path") {
            let mut runtime_handle = link
                .runtime_handle
                .as_object()
                .cloned()
                .unwrap_or_else(Map::new);
            runtime_handle.insert("threadPath".to_owned(), Value::String(path));
            link.runtime_handle = Value::Object(runtime_handle);
        }
        if local_active {
            link.status = "running".to_owned();
            link.running = true;
        }
        Some(link)
    }

    fn local_task_links(&self, include_archived: bool) -> Vec<RuntimeTaskLink> {
        self.store.list_task_summaries(include_archived)
    }

    fn local_task_link(&self, local_task_id: &str) -> Option<RuntimeTaskLink> {
        self.store.get_task(local_task_id)
    }

    fn archived_link_is_deleted(&self, link: &RuntimeTaskLink) -> bool {
        self.store.is_deleted_archived_task_id(&link.local_task_id)
            || link
                .thread_id
                .as_deref()
                .is_some_and(|thread_id| self.store.is_deleted_archived_task_id(thread_id))
    }

    fn mark_archived_link_deleted(&self, link: &RuntimeTaskLink) {
        let mut ids = vec![link.local_task_id.clone()];
        if let Some(thread_id) = &link.thread_id {
            ids.push(thread_id.clone());
        }
        self.store.mark_deleted_archived_task_ids(ids);
    }

    async fn archived_cleanup_links(
        &self,
        payload: &Value,
    ) -> Result<Vec<RuntimeTaskLink>, AppIpcError> {
        let items = payload
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if items.is_empty() {
            return Ok(self.collect_links(true).await);
        }

        let mut links = Vec::new();
        let mut seen = HashSet::new();
        for item in items {
            let local_task_id = runtime_task_id(&item)
                .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
            let payload_thread_id = runtime_session_id_from_payload(&item);
            let link = archived_link_from_payload_item(&item, local_task_id, payload_thread_id);
            if seen.insert(link.local_task_id.clone()) {
                links.push(link);
            }
        }
        Ok(links)
    }

    fn local_task_by_thread_id(&self, thread_id: &str) -> Option<RuntimeTaskLink> {
        self.store.find_summary_by_thread_id(thread_id)
    }

    fn upsert_local_task(&self, link: RuntimeTaskLink) {
        self.store.upsert_task(link);
    }

    fn mark_active_local_task(&self, local_task_id: &str) {
        self.active_local_tasks
            .lock()
            .expect("active local task set lock should not be poisoned")
            .insert(local_task_id.to_owned());
    }

    fn unmark_active_local_task(&self, local_task_id: &str) {
        self.active_local_tasks
            .lock()
            .expect("active local task set lock should not be poisoned")
            .remove(local_task_id);
    }

    fn set_active_turn_cancellation(&self, local_task_id: String, control: ActiveTurnCancellation) {
        if let Some(previous) = self
            .active_turn_cancellations
            .lock()
            .expect("active turn cancellation map lock should not be poisoned")
            .insert(local_task_id, control)
        {
            let _ = previous.cancel.send(());
        }
    }

    fn clear_active_turn_cancellation(&self, local_task_id: &str) {
        self.active_turn_cancellations
            .lock()
            .expect("active turn cancellation map lock should not be poisoned")
            .remove(local_task_id);
    }

    fn record_active_codex_turn(&self, local_task_id: &str, thread_id: String, turn_id: String) {
        self.active_codex_turns
            .lock()
            .expect("active codex turn map lock should not be poisoned")
            .insert(
                local_task_id.to_owned(),
                ActiveCodexTurn { thread_id, turn_id },
            );
    }

    fn active_codex_turn(&self, local_task_id: &str) -> Option<ActiveCodexTurn> {
        self.active_codex_turns
            .lock()
            .expect("active codex turn map lock should not be poisoned")
            .get(local_task_id)
            .cloned()
    }

    async fn wait_for_active_codex_turn(&self, local_task_id: &str) -> Option<ActiveCodexTurn> {
        for attempt in 0..=ACTIVE_CODEX_TURN_WAIT_ATTEMPTS {
            if let Some(turn) = self.active_codex_turn(local_task_id) {
                return Some(turn);
            }
            if !self.is_active_local_task(local_task_id)
                || attempt == ACTIVE_CODEX_TURN_WAIT_ATTEMPTS
            {
                return None;
            }
            tokio::time::sleep(std::time::Duration::from_millis(ACTIVE_CODEX_TURN_WAIT_MS)).await;
        }
        None
    }

    fn clear_active_codex_turn(&self, local_task_id: &str) {
        self.active_codex_turns
            .lock()
            .expect("active codex turn map lock should not be poisoned")
            .remove(local_task_id);
    }

    async fn abort_active_turn(&self, local_task_id: &str) -> bool {
        let control = {
            self.active_turn_cancellations
                .lock()
                .expect("active turn cancellation map lock should not be poisoned")
                .remove(local_task_id)
        };
        if let Some(control) = control {
            let _ = control.cancel.send(());
            let stopped =
                tokio::time::timeout(std::time::Duration::from_secs(10), control.stopped).await;
            if stopped.is_err() {
                return false;
            }
        }
        self.clear_active_codex_turn(local_task_id);
        self.unmark_active_local_task(local_task_id);
        true
    }

    fn is_active_local_task(&self, local_task_id: &str) -> bool {
        self.active_local_tasks
            .lock()
            .expect("active local task set lock should not be poisoned")
            .contains(local_task_id)
    }

    fn finish_local_task(&self, local_task_id: &str, thread_id: Option<String>, status: &str) {
        self.clear_active_turn_cancellation(local_task_id);
        self.store.update_task(local_task_id, |link| {
            if thread_id.is_some() {
                link.thread_id = thread_id;
            }
            link.status = status.to_owned();
            link.running = status == "running";
            link.updated_at = now_ms();
            if status != "running" {
                link.completed_at = Some(link.updated_at);
            }
            if link.thread_id.is_some() && status != "running" {
                retain_runtime_handle_user_messages(&mut link.runtime_handle);
            }
        });
        if status != "running" {
            self.unmark_active_local_task(local_task_id);
        }
    }

    fn sync_runtime_task_goal_from_notification(&self, local_task_id: &str, message: &Value) {
        let notification = codex_notification(message);
        let goal_status = match notification.method.as_str() {
            "thread/goal/updated" => notification
                .params
                .get("goal")
                .and_then(|goal| string_field(goal, "status")),
            "thread/goal/cleared" => None,
            _ => return,
        };
        self.sync_runtime_task_goal_status(local_task_id, goal_status);
    }

    fn sync_runtime_task_goal_status(&self, local_task_id: &str, goal_status: Option<String>) {
        self.store.update_task(local_task_id, |link| {
            link.goal_status = goal_status.clone();
            link.updated_at = now_ms();
        });
    }
}

fn is_unmapped_pending_codex_shadow(
    link: &RuntimeTaskLink,
    discovered_codex_task_signatures: &HashSet<String>,
) -> bool {
    is_unmapped_pending_codex_task(link)
        && codex_task_signature(link)
            .as_ref()
            .is_some_and(|signature| discovered_codex_task_signatures.contains(signature))
}

fn normalize_inactive_running_codex_task(link: &mut RuntimeTaskLink) -> bool {
    if !is_inactive_running_codex_task(link) {
        return false;
    }
    link.status = "active".to_owned();
    link.running = false;
    link.updated_at = now_ms();
    true
}

fn is_inactive_running_codex_task(link: &RuntimeTaskLink) -> bool {
    if !link.running || !is_codex_runtime(&link.runtime) {
        return false;
    }
    let status = link.status.replace(['_', '-'], "").to_ascii_lowercase();
    matches!(
        status.as_str(),
        "running" | "inprogress" | "busy" | "pending"
    )
}

fn is_unmapped_pending_codex_task(link: &RuntimeTaskLink) -> bool {
    if !is_inactive_running_codex_task(link) {
        return false;
    }
    link.thread_id.is_none()
}

fn codex_task_signature(link: &RuntimeTaskLink) -> Option<String> {
    if !is_codex_runtime(&link.runtime) {
        return None;
    }
    let title = link.title.trim().to_ascii_lowercase();
    if title.is_empty() || link.workspace_path.trim().is_empty() {
        return None;
    }
    Some(format!(
        "{}\0{}",
        workspace_group_path(&link.workspace_path),
        title
    ))
}

fn task_fields(task_id: &str, subtask_id: &str) -> Vec<(&'static str, String)> {
    vec![
        ("task_id", task_id.to_owned()),
        ("subtask_id", subtask_id.to_owned()),
    ]
}

fn request_user_input_response(payload: &Value) -> Option<Value> {
    payload
        .get("requestUserInputResponse")
        .or_else(|| payload.get("request_user_input_response"))
        .filter(|value| value.is_object())
        .cloned()
}

fn empty_request_user_input_response() -> Value {
    json!({ "answers": {} })
}

struct RuntimeTranscriptLog<'a> {
    started_at: Instant,
    local_task_id: &'a str,
    thread_id: &'a str,
    source: &'a str,
    refresh: bool,
    running_hint: bool,
    limit: Option<usize>,
    before_cursor: Option<&'a str>,
    after_cursor: Option<&'a str>,
    message_count: usize,
    running: bool,
}

struct RuntimeProjectFilterLog<'a> {
    action: &'a str,
    reason: &'a str,
    workspace_kind: &'a str,
    group_path: Option<&'a str>,
    matched_by: Option<&'a str>,
    project_workspace_path: Option<&'a str>,
    project_name: Option<&'a str>,
    thread_hint: Option<&'a str>,
    project_count: usize,
}

fn log_runtime_project_filter_item(link: &RuntimeTaskLink, details: RuntimeProjectFilterLog<'_>) {
    log_executor_event(
        "runtime work project filter item",
        &[
            ("action", details.action.to_owned()),
            ("reason", details.reason.to_owned()),
            ("local_task_id", link.local_task_id.clone()),
            (
                "thread_id",
                link.thread_id.as_deref().unwrap_or("none").to_owned(),
            ),
            ("title", link.title.clone()),
            ("runtime", link.runtime.clone()),
            ("status", link.status.clone()),
            ("workspace_path", link.workspace_path.clone()),
            ("workspace_kind", details.workspace_kind.to_owned()),
            ("group_path", optional_str(details.group_path)),
            ("matched_by", optional_str(details.matched_by)),
            (
                "project_workspace_path",
                optional_str(details.project_workspace_path),
            ),
            ("project_name", optional_str(details.project_name)),
            ("thread_hint", optional_str(details.thread_hint)),
            ("project_count", details.project_count.to_string()),
        ],
    );
}

fn log_runtime_archive_link(event: &str, link: &RuntimeTaskLink, archived_query: bool) {
    log_executor_event(
        event,
        &[
            ("archived_query", archived_query.to_string()),
            ("local_task_id", link.local_task_id.clone()),
            (
                "thread_id",
                link.thread_id.as_deref().unwrap_or("none").to_owned(),
            ),
            ("workspace_path", link.workspace_path.clone()),
            ("runtime", link.runtime.clone()),
            ("status", link.status.clone()),
            ("running", link.running.to_string()),
            (
                "session_id",
                runtime_session_id_from_link(link).unwrap_or_else(|| "none".to_owned()),
            ),
        ],
    );
}

fn log_runtime_transcript_finished(details: RuntimeTranscriptLog<'_>) {
    log_executor_event(
        "runtime work transcript finished",
        &[
            ("elapsed_ms", elapsed_ms(details.started_at)),
            ("local_task_id", details.local_task_id.to_owned()),
            ("thread_id", details.thread_id.to_owned()),
            ("source", details.source.to_owned()),
            ("refresh", details.refresh.to_string()),
            ("running_hint", details.running_hint.to_string()),
            ("running", details.running.to_string()),
            ("limit", optional_usize(details.limit)),
            ("before_cursor", details.before_cursor.is_some().to_string()),
            ("after_cursor", details.after_cursor.is_some().to_string()),
            ("messages", details.message_count.to_string()),
        ],
    );
}

fn elapsed_ms(started_at: Instant) -> String {
    started_at.elapsed().as_millis().to_string()
}

fn optional_usize(value: Option<usize>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "none".to_owned())
}

fn optional_str(value: Option<&str>) -> String {
    value
        .map(str::to_owned)
        .unwrap_or_else(|| "none".to_owned())
}

fn codex_project_workspaces(project_index: &CodexGlobalProjectIndex) -> Vec<RuntimeWorkspaceLink> {
    let now = now_ms();
    project_index
        .projects()
        .iter()
        .flat_map(|project| {
            let roots = if project.roots.is_empty() {
                vec![project.workspace_path.clone()]
            } else {
                project.roots.clone()
            };
            roots.into_iter().map(|root| RuntimeWorkspaceLink {
                workspace_path: root,
                title: project.name.clone(),
                runtime: "codex".to_owned(),
                created_at: now,
                updated_at: now,
                workspace_source: project.kind.clone(),
                remote_host_id: project.remote_host_id.clone(),
                project_key: project.key.clone(),
                project_kind: project.kind.clone(),
                project_source: project.source.clone(),
                project_roots: project.roots.clone(),
                project_pinned: project.pinned,
                project_pinned_order: project.pinned_order,
                project_active: project.active,
                project_appearance: project.appearance.clone(),
            })
        })
        .collect()
}

fn codex_started_thread_id(message: &Value) -> Option<String> {
    let notification = codex_notification(message);
    if notification.method != "thread/started" {
        return None;
    }
    notification
        .params
        .get("thread")
        .and_then(|thread| string_field(thread, "id"))
        .or_else(|| string_field(notification.params, "threadId"))
        .or_else(|| string_field(notification.params, "thread_id"))
}

fn pending_thread_event_route_id(local_task_id: &str) -> String {
    format!("{PENDING_THREAD_EVENT_ROUTE_PREFIX}{local_task_id}")
}

fn is_pending_thread_event_route_id(route_id: &str) -> bool {
    route_id.starts_with(PENDING_THREAD_EVENT_ROUTE_PREFIX)
}

fn codex_notification_thread_id(message: &Value) -> Option<String> {
    let notification = codex_notification(message);
    codex_stream_thread_id(notification.params).or_else(|| codex_stream_thread_id(message))
}

fn codex_stream_thread_id(value: &Value) -> Option<String> {
    string_field(value, "threadId")
        .or_else(|| string_field(value, "thread_id"))
        .or_else(|| {
            value.get("item").and_then(|item| {
                string_field(item, "threadId").or_else(|| string_field(item, "thread_id"))
            })
        })
        .or_else(|| {
            value.get("payload").and_then(|payload| {
                string_field(payload, "threadId").or_else(|| string_field(payload, "thread_id"))
            })
        })
        .or_else(|| {
            value.get("thread").and_then(|thread| {
                string_field(thread, "id")
                    .or_else(|| string_field(thread, "threadId"))
                    .or_else(|| string_field(thread, "thread_id"))
            })
        })
}

fn debug_unrouted_codex_notification(message: &Value, reason: &str) {
    let notification = codex_notification(message);
    let raw = serde_json::to_string(message)
        .unwrap_or_else(|error| format!("<failed to serialize raw message: {error}>"));
    log_executor_event(
        "runtime work codex notification unrouted",
        &[
            ("reason", reason.to_owned()),
            ("method", notification.method),
            ("raw_len", raw.len().to_string()),
            ("raw", raw),
        ],
    );
}

fn runtime_event_request_from_link(link: &RuntimeTaskLink) -> ExecutionRequest {
    ExecutionRequest {
        task_id: link.local_task_id.clone(),
        subtask_id: format!("{}-context-compact", link.local_task_id),
        project_workspace_path: Some(link.workspace_path.clone()),
        prompt: Value::String(link.title.clone()),
        ..ExecutionRequest::default()
    }
}

fn runtime_project_workspace_path(
    payload: &Value,
    project_index: &CodexGlobalProjectIndex,
) -> Option<String> {
    workspace_path(payload)
        .map(|path| {
            project_index
                .project_for_key(&path)
                .map(|project| project.workspace_path.clone())
                .unwrap_or_else(|| workspace_group_path(&path))
        })
        .or_else(|| {
            let key = string_field(payload, "runtimeProjectKey")
                .or_else(|| string_field(payload, "runtime_project_key"))?;
            let normalized_key = key.strip_prefix("local:").unwrap_or(&key);
            project_index
                .project_for_key(normalized_key)
                .map(|project| project.workspace_path.clone())
                .or_else(|| Some(super::util::normalize_workspace_path(normalized_key)))
        })
}

fn codex_thread_list_params(archived: bool, cursor: Option<&str>) -> Value {
    let mut params = json!({
        "limit": CODEX_THREAD_LIST_PAGE_SIZE,
        "sortKey": "updated_at",
        "sortDirection": "desc",
        "sourceKinds": CODEX_THREAD_SOURCE_KINDS,
        "archived": archived,
        "useStateDbOnly": true,
    });
    if let Some(cursor) = cursor {
        params["cursor"] = Value::String(cursor.to_owned());
    }
    params
}

fn payload_runtime_is_codex(payload: &Value) -> bool {
    string_field(payload, "runtime")
        .map(|runtime| is_codex_runtime(&runtime))
        .unwrap_or(true)
}

fn is_cached_codex_link_hidden(
    link: &RuntimeTaskLink,
    discovered_thread_ids: &HashSet<String>,
) -> bool {
    is_codex_runtime(&link.runtime)
        && !link.running
        && link
            .thread_id
            .as_ref()
            .is_some_and(|thread_id| discovered_thread_ids.contains(thread_id))
        && link.status != "archived"
}

fn is_codex_runtime(runtime: &str) -> bool {
    runtime.eq_ignore_ascii_case("codex")
}

fn append_unique_links(links: &mut Vec<RuntimeTaskLink>, new_links: Vec<RuntimeTaskLink>) {
    let mut keys = links.iter().map(link_key).collect::<HashSet<_>>();
    for link in new_links {
        if keys.insert(link_key(&link)) {
            links.push(link);
        }
    }
}

fn link_key(link: &RuntimeTaskLink) -> String {
    link.thread_id
        .clone()
        .unwrap_or_else(|| link.local_task_id.clone())
}

fn text_match(text: &str, query: &str) -> Option<(usize, usize)> {
    let normalized_query = query.trim().to_ascii_lowercase();
    if normalized_query.is_empty() {
        return None;
    }
    let normalized_text = text.to_ascii_lowercase();
    normalized_text
        .find(&normalized_query)
        .map(|start| (start, start + normalized_query.len()))
}

fn first_message_search_result(
    link: &RuntimeTaskLink,
    device_id: &str,
    messages: Vec<Value>,
    query: &str,
) -> Option<Value> {
    for message in messages {
        let content = string_field(&message, "content").unwrap_or_default();
        let Some((match_start, match_end)) = text_match(&content, query) else {
            continue;
        };
        let snippet = bounded_search_snippet(&content, match_start, match_end);
        return Some(search_result_item(
            link,
            device_id,
            SearchResultMatch {
                snippet: snippet.text,
                match_start: snippet.match_start,
                match_end: snippet.match_end,
                message_id: string_field(&message, "id").unwrap_or_default(),
                message_role: string_field(&message, "role")
                    .unwrap_or_else(|| "message".to_owned()),
                message_created_at: message.get("createdAt").cloned().unwrap_or(Value::Null),
            },
        ));
    }
    None
}

struct SearchSnippet {
    text: String,
    match_start: usize,
    match_end: usize,
}

fn bounded_search_snippet(text: &str, match_start: usize, match_end: usize) -> SearchSnippet {
    let total_chars = text.chars().count();
    if total_chars <= SEARCH_SNIPPET_MAX_CHARS {
        return SearchSnippet {
            text: text.to_owned(),
            match_start,
            match_end,
        };
    }

    let match_start_char = text[..match_start].chars().count();
    let match_end_char = text[..match_end].chars().count();
    let match_chars = match_end_char.saturating_sub(match_start_char);
    let context_budget = SEARCH_SNIPPET_MAX_CHARS.saturating_sub(match_chars);
    let before_budget = context_budget.min(SEARCH_SNIPPET_CONTEXT_CHARS);
    let after_budget = context_budget.saturating_sub(before_budget);
    let before_chars = before_budget.min(match_start_char);
    let mut after_chars = after_budget.min(total_chars.saturating_sub(match_end_char));

    let unused_before_budget = before_budget.saturating_sub(before_chars);
    if unused_before_budget > 0 {
        after_chars =
            (after_chars + unused_before_budget).min(total_chars.saturating_sub(match_end_char));
    }

    let snippet_start_char = match_start_char.saturating_sub(before_chars);
    let snippet_end_char = (match_end_char + after_chars).min(total_chars);
    let snippet_start_byte = byte_index_for_char(text, snippet_start_char);
    let snippet_end_byte = byte_index_for_char(text, snippet_end_char);

    SearchSnippet {
        text: text[snippet_start_byte..snippet_end_byte].to_owned(),
        match_start: match_start.saturating_sub(snippet_start_byte),
        match_end: match_end.saturating_sub(snippet_start_byte),
    }
}

fn byte_index_for_char(text: &str, char_index: usize) -> usize {
    text.char_indices()
        .nth(char_index)
        .map(|(byte_index, _)| byte_index)
        .unwrap_or(text.len())
}

fn cached_transcript_response(
    link: &RuntimeTaskLink,
    messages: Vec<Value>,
    context_usage: Option<Value>,
    running: bool,
    limit: Option<usize>,
    before_cursor: Option<&str>,
    after_cursor: Option<&str>,
) -> Value {
    transcript_response(TranscriptResponseInput {
        local_task_id: link.local_task_id.clone(),
        workspace_path: link.workspace_path.clone(),
        runtime: link.runtime.clone(),
        messages,
        context_usage,
        running,
        limit,
        before_cursor: before_cursor.map(ToOwned::to_owned),
        after_cursor: after_cursor.map(ToOwned::to_owned),
        full_content: false,
    })
}

struct TranscriptResponseInput {
    local_task_id: String,
    workspace_path: String,
    runtime: String,
    messages: Vec<Value>,
    context_usage: Option<Value>,
    running: bool,
    limit: Option<usize>,
    before_cursor: Option<String>,
    after_cursor: Option<String>,
    full_content: bool,
}

fn transcript_response(input: TranscriptResponseInput) -> Value {
    let TranscriptResponseInput {
        local_task_id,
        workspace_path,
        runtime,
        messages,
        context_usage,
        running,
        limit,
        before_cursor,
        after_cursor,
        full_content,
    } = input;
    let turn_navigation = transcript_turn_navigation(&messages);
    let page = transcript_page(
        messages,
        limit,
        before_cursor.as_deref(),
        after_cursor.as_deref(),
    );
    json!({
        "success": true,
        "taskId": local_task_id,
        "workspacePath": workspace_path,
        "runtime": runtime,
        "running": running,
        "messages": page.messages,
        "fullContent": full_content,
        "contextUsage": context_usage.unwrap_or(Value::Null),
        "turnNavigation": turn_navigation,
        "rangeStart": page.range_start,
        "rangeEnd": page.range_end,
        "hasMoreBefore": page.has_more_before,
        "beforeCursor": page
            .before_cursor
            .map(Value::String)
            .unwrap_or(Value::Null),
        "hasMoreAfter": page.has_more_after,
        "afterCursor": page
            .after_cursor
            .map(Value::String)
            .unwrap_or(Value::Null),
    })
}

fn transcript_context_usage(thread: &Value) -> Option<Value> {
    rollout_context_usage(thread)
}

fn transcript_turn_navigation(messages: &[Value]) -> Vec<Value> {
    let mut turns: Vec<Value> = Vec::new();
    let mut pending_response_turn_indexes: Vec<usize> = Vec::new();

    for (message_index, message) in messages.iter().enumerate() {
        let role = string_field(message, "role").unwrap_or_default();
        if !role.eq_ignore_ascii_case("user") {
            if role.eq_ignore_ascii_case("assistant") && !pending_response_turn_indexes.is_empty() {
                let response_preview = transcript_message_preview(message);
                for turn_index in pending_response_turn_indexes.drain(..) {
                    if let Some(turn) = turns.get_mut(turn_index).and_then(Value::as_object_mut) {
                        turn.insert(
                            "responsePreview".to_owned(),
                            Value::String(response_preview.clone()),
                        );
                    }
                }
            }
            continue;
        }

        turns.push(json!({
            "id": string_field(message, "id").unwrap_or_else(|| format!("message-{message_index}")),
            "turnIndex": turns.len(),
            "messageIndex": message_index,
            "cursor": format!("offset:{message_index}"),
            "promptPreview": transcript_message_preview(message),
            "responsePreview": "",
        }));
        pending_response_turn_indexes.push(turns.len() - 1);
    }

    turns
}

fn transcript_message_preview(message: &Value) -> String {
    truncate_navigation_preview(&string_field(message, "content").unwrap_or_default())
}

fn truncate_navigation_preview(content: &str) -> String {
    let normalized = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut preview = String::new();
    for (index, ch) in normalized.chars().enumerate() {
        if index >= TRANSCRIPT_NAVIGATION_PREVIEW_CHARS {
            preview.push('…');
            return preview;
        }
        preview.push(ch);
    }
    preview
}

fn transcript_limit(payload: &Value) -> Option<usize> {
    integer_field(payload, "limit")
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
}

fn codex_thread_has_active_turn(thread: &Value) -> bool {
    codex_thread_is_active(thread)
}

fn cached_runtime_transcript_messages(link: &RuntimeTaskLink) -> Vec<Value> {
    let messages = cached_messages(link);
    if !runtime_has_provider_transcript_reader(&link.runtime) {
        return messages;
    }
    messages
        .into_iter()
        .filter(|message| {
            !string_field(message, "role")
                .is_some_and(|role| role.eq_ignore_ascii_case("assistant"))
        })
        .collect()
}

fn append_missing_cached_user_messages(messages: &mut Vec<Value>, cached_messages: Vec<Value>) {
    let mut provider_user_message_counts = HashMap::<String, usize>::new();
    for message in messages.iter() {
        if let Some(signature) = cached_user_message_signature(message) {
            *provider_user_message_counts.entry(signature).or_default() += 1;
        }
    }

    for message in cached_messages {
        let Some(signature) = cached_user_message_signature(&message) else {
            continue;
        };
        let remaining = provider_user_message_counts.entry(signature).or_default();
        if *remaining > 0 {
            *remaining -= 1;
        } else {
            messages.push(message);
        }
    }
}

fn cached_user_message_signature(message: &Value) -> Option<String> {
    string_field(message, "role")
        .filter(|role| role.eq_ignore_ascii_case("user"))
        .and_then(|_| string_field(message, "content"))
}

fn cached_user_message(
    local_task_id: &str,
    request: &ExecutionRequest,
    payload: &Value,
) -> Option<Value> {
    let content = payload
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| payload.get("content").and_then(Value::as_str))
        .filter(|content| !content.trim().is_empty())?;

    let mut message = Map::new();
    message.insert(
        "id".to_owned(),
        Value::String(format!(
            "{local_task_id}:user:{}",
            if !request.subtask_id.trim().is_empty() {
                request.subtask_id.clone()
            } else {
                now_ms().to_string()
            }
        )),
    );
    message.insert("role".to_owned(), Value::String("user".to_owned()));
    message.insert("content".to_owned(), Value::String(content.to_owned()));
    message.insert("status".to_owned(), Value::String("done".to_owned()));
    message.insert("createdAt".to_owned(), Value::Number(now_ms().into()));
    if let Some(source) = payload
        .get("source")
        .filter(|value| value.is_object())
        .cloned()
    {
        message.insert("source".to_owned(), source);
    }
    let attachments = normalized_attachments(payload.get("attachments"));
    if !attachments.is_empty() {
        message.insert("attachments".to_owned(), Value::Array(attachments));
    }
    Some(Value::Object(message))
}

fn normalized_attachments(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|attachment| {
            let object = attachment.as_object()?;
            let mut normalized = Map::new();
            if let Some(id) = object.get("id").cloned() {
                normalized.insert("id".to_owned(), id);
            }
            let filename = object
                .get("filename")
                .or_else(|| object.get("original_filename"))
                .and_then(Value::as_str)
                .unwrap_or("attachment")
                .to_owned();
            normalized.insert("filename".to_owned(), Value::String(filename));
            copy_attachment_field(object, &mut normalized, "file_size");
            copy_attachment_field(object, &mut normalized, "mime_type");
            copy_attachment_field(object, &mut normalized, "subtask_id");
            copy_attachment_field(object, &mut normalized, "file_extension");
            copy_attachment_field(object, &mut normalized, "text_length");
            copy_attachment_field(object, &mut normalized, "text_preview");
            copy_attachment_field_alias(
                object,
                &mut normalized,
                "local_path",
                &["local_path", "localPath"],
            );
            copy_attachment_field_alias(
                object,
                &mut normalized,
                "local_preview_url",
                &["local_preview_url", "localPreviewUrl"],
            );
            if !normalized.contains_key("local_preview_url") {
                if let Some(local_path) = normalized.get("local_path").cloned() {
                    normalized.insert("local_preview_url".to_owned(), local_path);
                }
            }
            normalized.insert("status".to_owned(), Value::String("ready".to_owned()));
            normalized.insert("created_at".to_owned(), Value::Number(now_ms().into()));
            Some(Value::Object(normalized))
        })
        .collect()
}

fn guidance_image_inputs(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|attachment| {
            let mime_type = string_field(attachment, "mime_type")
                .or_else(|| string_field(attachment, "mimeType"))?;
            if !mime_type.starts_with("image/") {
                return None;
            }
            let path = string_field(attachment, "local_path")
                .or_else(|| string_field(attachment, "localPath"))?;
            Some(json!({ "type": "localImage", "path": path }))
        })
        .collect()
}

fn guidance_input_items(message: &str, attachments: Option<&Value>) -> Vec<Value> {
    let mut inputs = Vec::new();
    if !message.trim().is_empty() {
        inputs.push(json!({ "type": "text", "text": message }));
    }
    inputs.extend(guidance_image_inputs(attachments));
    inputs
}

fn codex_guidance_failure_code(error: &str) -> &'static str {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("no active turn to steer")
        || (normalized.contains("expected active turn id") && normalized.contains("but found"))
    {
        "no_active_turn"
    } else {
        "guidance_failed"
    }
}

fn copy_attachment_field(source: &Map<String, Value>, target: &mut Map<String, Value>, key: &str) {
    if let Some(value) = source.get(key).cloned() {
        target.insert(key.to_owned(), value);
    }
}

fn copy_attachment_field_alias(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    target_key: &str,
    source_keys: &[&str],
) {
    for source_key in source_keys {
        if let Some(value) = source.get(*source_key).cloned() {
            target.insert(target_key.to_owned(), value);
            return;
        }
    }
}

fn runtime_handle_json(link: &RuntimeTaskLink) -> Value {
    let mut object = link
        .runtime_handle
        .as_object()
        .cloned()
        .unwrap_or_else(Map::new);
    object.insert(
        "threadId".to_owned(),
        link.thread_id
            .as_ref()
            .map(|thread_id| Value::String(thread_id.clone()))
            .unwrap_or(Value::Null),
    );
    Value::Object(object)
}

fn set_runtime_handle_model_selection(runtime_handle: &mut Value, payload: &Value) {
    if let Some(selection) = payload
        .get("modelSelection")
        .or_else(|| payload.get("model_selection"))
        .filter(|value| value.is_object())
    {
        let mut object = runtime_handle.as_object().cloned().unwrap_or_default();
        object.insert("modelSelection".to_owned(), selection.clone());
        *runtime_handle = Value::Object(object);
        return;
    }

    let Some(model_name) =
        string_field(payload, "modelId").or_else(|| string_field(payload, "model_id"))
    else {
        return;
    };
    let mut selection = Map::new();
    selection.insert("modelName".to_owned(), Value::String(model_name));
    selection.insert(
        "modelType".to_owned(),
        string_field(payload, "modelType")
            .or_else(|| string_field(payload, "model_type"))
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    selection.insert(
        "options".to_owned(),
        payload
            .get("modelOptions")
            .or_else(|| payload.get("model_options"))
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({})),
    );

    let mut object = runtime_handle.as_object().cloned().unwrap_or_default();
    object.insert("modelSelection".to_owned(), Value::Object(selection));
    *runtime_handle = Value::Object(object);
}

fn runtime_session_id_from_link(link: &RuntimeTaskLink) -> Option<String> {
    link.thread_id
        .clone()
        .or_else(|| runtime_session_id_from_handle(&link.runtime_handle))
}

fn codex_thread_id_from_link(link: &RuntimeTaskLink) -> Option<String> {
    runtime_session_id_from_link(link).filter(|thread_id| is_codex_thread_id(thread_id))
}

fn is_codex_thread_id(thread_id: &str) -> bool {
    let thread_id = thread_id.strip_prefix("urn:uuid:").unwrap_or(thread_id);
    thread_id.len() == 36
        && thread_id
            .chars()
            .enumerate()
            .all(|(index, character)| match index {
                8 | 13 | 18 | 23 => character == '-',
                _ => character.is_ascii_hexdigit(),
            })
}

fn runtime_thread_path_from_link(link: &RuntimeTaskLink) -> Option<String> {
    string_field(&link.runtime_handle, "threadPath")
        .or_else(|| string_field(&link.runtime_handle, "thread_path"))
        .or_else(|| string_field(&link.runtime_handle, "path"))
        .filter(|path| !path.trim().is_empty())
}

fn archived_link_from_payload_item(
    item: &Value,
    local_task_id: String,
    thread_id: Option<String>,
) -> RuntimeTaskLink {
    let workspace_path = workspace_path(item).unwrap_or_default();
    let title = string_field(item, "title").unwrap_or_else(|| local_task_id.clone());
    let mut link = RuntimeTaskLink::new_pending(local_task_id.clone(), workspace_path, title);
    link.thread_id = thread_id;
    if let Some(runtime_handle) = item
        .get("runtimeHandle")
        .or_else(|| item.get("runtime_handle"))
        .cloned()
    {
        link.runtime_handle = runtime_handle;
    }
    link.status = "archived".to_owned();
    link.running = false;
    link
}

fn runtime_session_id_from_payload(payload: &Value) -> Option<String> {
    let address = payload.get("address");
    string_field(payload, "threadId")
        .or_else(|| string_field(payload, "thread_id"))
        .or_else(|| address.and_then(|address| string_field(address, "threadId")))
        .or_else(|| address.and_then(|address| string_field(address, "thread_id")))
        .or_else(|| {
            payload
                .get("runtimeHandle")
                .or_else(|| payload.get("runtime_handle"))
                .and_then(runtime_session_id_from_handle)
        })
        .or_else(|| {
            address.and_then(|address| {
                address
                    .get("runtimeHandle")
                    .or_else(|| address.get("runtime_handle"))
                    .and_then(runtime_session_id_from_handle)
            })
        })
        .or_else(|| string_field(payload, "providerSessionId"))
        .or_else(|| string_field(payload, "provider_session_id"))
        .or_else(|| address.and_then(|address| string_field(address, "providerSessionId")))
        .or_else(|| address.and_then(|address| string_field(address, "provider_session_id")))
}

fn initial_thread_goal_from_payload(payload: &Value) -> Option<Value> {
    payload
        .get("initialGoal")
        .or_else(|| payload.get("initial_goal"))
        .filter(|goal| goal.is_object())
        .cloned()
}

fn side_source_thread(payload: &Value) -> Option<SideSourceThread> {
    let source = payload
        .get("sideSource")
        .or_else(|| payload.get("side_source"))?;
    let handle = source
        .get("runtimeHandle")
        .or_else(|| source.get("runtime_handle"));
    let thread_id = string_field(source, "threadId")
        .or_else(|| string_field(source, "thread_id"))
        .or_else(|| handle.and_then(runtime_session_id_from_handle))
        .filter(|thread_id| !thread_id.trim().is_empty())?;
    let thread_path = string_field(source, "threadPath")
        .or_else(|| string_field(source, "thread_path"))
        .or_else(|| string_field(source, "path"))
        .or_else(|| {
            handle.and_then(|handle| {
                string_field(handle, "threadPath")
                    .or_else(|| string_field(handle, "thread_path"))
                    .or_else(|| string_field(handle, "path"))
            })
        })
        .filter(|path| !path.trim().is_empty());
    Some(SideSourceThread {
        thread_id,
        thread_path,
    })
}

fn runtime_session_id_from_handle(handle: &Value) -> Option<String> {
    string_field(handle, "sessionId")
        .or_else(|| string_field(handle, "session_id"))
        .or_else(|| string_field(handle, "threadId"))
        .or_else(|| string_field(handle, "thread_id"))
        .or_else(|| string_field(handle, "conversationId"))
        .or_else(|| string_field(handle, "conversation_id"))
}

fn runtime_has_provider_transcript_reader(runtime: &str) -> bool {
    runtime.trim().eq_ignore_ascii_case("codex")
}

fn source_parent_json(source: &super::fork_transfer::SourceTaskIdentity) -> Value {
    let mut parent = Map::new();
    if let Some(device_id) = &source.device_id {
        parent.insert("deviceId".to_owned(), Value::String(device_id.clone()));
    }
    if let Some(workspace_path) = &source.workspace_path {
        parent.insert(
            "workspacePath".to_owned(),
            Value::String(workspace_path.clone()),
        );
    }
    parent.insert(
        "taskId".to_owned(),
        Value::String(source.local_task_id.clone()),
    );
    if let Some(thread_id) = &source.thread_id {
        parent.insert("threadId".to_owned(), Value::String(thread_id.clone()));
    }
    if let Some(runtime) = &source.runtime {
        parent.insert("runtime".to_owned(), Value::String(runtime.clone()));
    }
    Value::Object(parent)
}

fn fork_error_response(code: &str, error: String) -> Value {
    json!({
        "success": false,
        "error": error,
        "code": code,
    })
}

fn cleanup_task_files_preview(link: &RuntimeTaskLink) -> Value {
    cleanup_task_files_response(link, false, true)
}

fn cleanup_task_files_response(link: &RuntimeTaskLink, delete: bool, measure_bytes: bool) -> Value {
    let targets = cleanup_targets_for_task(link);
    let mut cleaned_count = 0_u64;
    let mut skipped_count = 0_u64;
    let mut error_count = 0_u64;
    let mut total_bytes = 0_u64;
    let mut items = Vec::new();

    for target in targets {
        let exists = target.path.exists();
        let bytes = if measure_bytes {
            path_size(&target.path).unwrap_or(0)
        } else {
            0
        };
        total_bytes = total_bytes.saturating_add(bytes);
        let mut item = json!({
            "kind": target.kind,
            "path": target.path.to_string_lossy(),
            "exists": exists,
            "bytes": bytes,
        });

        if !exists {
            skipped_count += 1;
            item["status"] = json!("missing");
            items.push(item);
            continue;
        }

        if delete {
            match remove_cleanup_target(&target) {
                Ok(()) => {
                    cleaned_count += 1;
                    item["status"] = json!("cleaned");
                }
                Err(error) => {
                    error_count += 1;
                    item["status"] = json!("failed");
                    item["error"] = json!(error);
                }
            }
        } else {
            cleaned_count += 1;
            item["status"] = json!("preview");
        }
        items.push(item);
    }

    json!({
        "taskId": link.local_task_id,
        "workspacePath": link.workspace_path,
        "targetCount": items.len(),
        "cleanableCount": cleaned_count,
        "skippedCount": skipped_count,
        "errorCount": error_count,
        "bytes": total_bytes,
        "items": items,
    })
}

fn cleanup_summary_response(results: Vec<Value>, deleted: bool) -> Value {
    let target_count = results
        .iter()
        .map(|result| {
            result
                .get("targetCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        })
        .sum::<u64>();
    let cleanable_count = results
        .iter()
        .map(|result| {
            result
                .get("cleanableCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        })
        .sum::<u64>();
    let skipped_count = results
        .iter()
        .map(|result| {
            result
                .get("skippedCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        })
        .sum::<u64>();
    let error_count = results
        .iter()
        .map(|result| {
            result
                .get("errorCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        })
        .sum::<u64>();
    let total_bytes = results
        .iter()
        .map(|result| result.get("bytes").and_then(Value::as_u64).unwrap_or(0))
        .sum::<u64>();

    json!({
        "success": error_count == 0,
        "deleted": deleted,
        "taskCount": results.len(),
        "targetCount": target_count,
        "cleanableCount": cleanable_count,
        "skippedCount": skipped_count,
        "errorCount": error_count,
        "bytes": total_bytes,
        "results": results,
    })
}

struct CleanupTarget {
    kind: &'static str,
    path: PathBuf,
}

fn cleanup_targets_for_task(link: &RuntimeTaskLink) -> Vec<CleanupTarget> {
    let mut targets = Vec::new();
    let mut seen = HashSet::new();
    push_cleanup_target(
        &mut targets,
        &mut seen,
        worktree_cleanup_target(&link.workspace_path),
    );
    push_cleanup_target(
        &mut targets,
        &mut seen,
        standalone_chat_cleanup_target(&link.local_task_id, &link.workspace_path),
    );
    push_cleanup_target(
        &mut targets,
        &mut seen,
        workspace_attachment_cleanup_target(link, ".wegent/attachments"),
    );
    push_cleanup_target(
        &mut targets,
        &mut seen,
        workspace_attachment_cleanup_target(
            link,
            &format!("{}:executor:attachments", link.local_task_id),
        ),
    );

    for path in local_attachment_paths(&link.runtime_handle) {
        push_cleanup_target(
            &mut targets,
            &mut seen,
            local_attachment_cleanup_target(&path),
        );
    }
    if let Some(parent) = &link.parent {
        for path in local_attachment_paths(parent) {
            push_cleanup_target(
                &mut targets,
                &mut seen,
                local_attachment_cleanup_target(&path),
            );
        }
    }

    targets
}

fn push_cleanup_target(
    targets: &mut Vec<CleanupTarget>,
    seen: &mut HashSet<String>,
    target: Option<CleanupTarget>,
) {
    let Some(target) = target else {
        return;
    };
    let key = normalize_workspace_path(&target.path.to_string_lossy());
    if seen.insert(key) {
        targets.push(target);
    }
}

fn worktree_cleanup_target(path: &str) -> Option<CleanupTarget> {
    let normalized = normalize_workspace_path(path);
    if !is_managed_worktree_path(&normalized) {
        return None;
    }
    Some(CleanupTarget {
        kind: "worktree",
        path: PathBuf::from(normalized),
    })
}

fn standalone_chat_cleanup_target(local_task_id: &str, path: &str) -> Option<CleanupTarget> {
    let normalized = normalize_workspace_path(path);
    if !normalized.contains("/Documents/Codex/") {
        return None;
    }
    let segment = workspace_segment(local_task_id);
    if Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())
        != Some(segment.as_str())
    {
        return None;
    }
    Some(CleanupTarget {
        kind: "standalone_workspace",
        path: PathBuf::from(normalized),
    })
}

fn workspace_attachment_cleanup_target(
    link: &RuntimeTaskLink,
    relative: &str,
) -> Option<CleanupTarget> {
    let workspace = PathBuf::from(normalize_workspace_path(&link.workspace_path));
    if workspace.as_os_str().is_empty() {
        return None;
    }
    let path = if relative == ".wegent/attachments" {
        workspace.join(relative).join(&link.local_task_id)
    } else {
        workspace.join(relative)
    };
    Some(CleanupTarget {
        kind: "workspace_attachment",
        path,
    })
}

fn local_attachment_cleanup_target(path: &str) -> Option<CleanupTarget> {
    let normalized = normalize_workspace_path(path);
    if !is_local_attachment_draft_path(&normalized) {
        return None;
    }
    Some(CleanupTarget {
        kind: "local_attachment",
        path: PathBuf::from(normalized),
    })
}

fn local_attachment_paths(value: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    collect_local_attachment_paths(value, &mut paths);
    paths
}

fn collect_local_attachment_paths(value: &Value, paths: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_local_attachment_paths(item, paths);
            }
        }
        Value::Object(map) => {
            for (key, value) in map {
                if matches!(
                    key.as_str(),
                    "local_path" | "localPath" | "local_preview_url" | "localPreviewUrl"
                ) {
                    if let Some(path) = value
                        .as_str()
                        .map(str::trim)
                        .filter(|path| !path.is_empty())
                    {
                        paths.push(path.to_owned());
                    }
                }
                collect_local_attachment_paths(value, paths);
            }
        }
        _ => {}
    }
}

fn remove_cleanup_target(target: &CleanupTarget) -> Result<(), String> {
    if target.kind == "worktree" {
        remove_git_worktree_best_effort(&target.path);
    }
    if target.path.is_dir() {
        fs::remove_dir_all(&target.path)
            .map_err(|error| format!("failed to remove directory: {error}"))?;
    } else if target.path.is_file() {
        fs::remove_file(&target.path).map_err(|error| format!("failed to remove file: {error}"))?;
    }
    Ok(())
}

fn remove_git_worktree_best_effort(path: &Path) {
    let path = path.to_string_lossy().to_string();
    let _ = std::process::Command::new("git")
        .args(["-C", &path, "worktree", "remove", "--force", &path])
        .output();
}

fn path_size(path: &Path) -> Option<u64> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.is_file() {
        return Some(metadata.len());
    }
    if !metadata.is_dir() {
        return Some(0);
    }
    let mut size = 0_u64;
    for entry in fs::read_dir(path).ok()? {
        let entry = entry.ok()?;
        size = size.saturating_add(path_size(&entry.path()).unwrap_or(0));
    }
    Some(size)
}

fn is_managed_worktree_path(path: &str) -> bool {
    path.contains("/.wecode/wegent-executor/workspace/worktrees/")
        || path.contains("/.wegent-executor/workspace/worktrees/")
}

fn is_local_attachment_draft_path(path: &str) -> bool {
    path.contains("/.wegent-executor/workspace/attachments/draft/")
        || path.contains("/.wecode/wegent-executor/workspace/attachments/draft/")
}

fn task_action_success(link: &RuntimeTaskLink) -> Value {
    json!({
        "success": true,
        "accepted": true,
        "taskId": link.local_task_id,
        "workspacePath": link.workspace_path,
        "runtime": link.runtime,
    })
}

fn sidebar_mutation_response(device_id: &str) -> Value {
    json!({
        "success": true,
        "accepted": true,
        "deviceId": device_id,
    })
}

fn task_action_failure(link: &RuntimeTaskLink, error: String) -> Value {
    json!({
        "success": false,
        "accepted": false,
        "taskId": link.local_task_id,
        "workspacePath": link.workspace_path,
        "runtime": link.runtime,
        "error": error,
    })
}

fn codex_error_is_missing_rollout(error: &str, thread_id: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("no rollout found for thread id")
        && error.contains(&thread_id.to_ascii_lowercase())
}

fn task_goal_missing_session(link: &RuntimeTaskLink) -> Value {
    json!({
        "success": false,
        "accepted": false,
        "taskId": link.local_task_id,
        "workspacePath": link.workspace_path,
        "runtime": link.runtime,
        "error": "runtime task session is not ready",
        "code": "missing_runtime_session",
    })
}

impl RuntimeWorkHandler for RuntimeWorkRpcHandler {
    fn handle_runtime_rpc<'a>(
        &'a self,
        data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            let method = string_field(&data, "method")
                .ok_or_else(|| AppIpcError::new("bad_request", "method is required"))?;
            let payload = data
                .get("payload")
                .cloned()
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({}));
            self.dispatch(&method, payload).await
        })
    }

    fn handle_codex_app_server_rpc<'a>(
        &'a self,
        data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            let method = string_field(&data, "method")
                .ok_or_else(|| AppIpcError::new("bad_request", "method is required"))?;
            if !is_allowed_plugin_app_server_method(&method) {
                return Err(AppIpcError::new(
                    "unsupported_codex_app_server_method",
                    format!("Unsupported Codex app-server method: {method}"),
                ));
            }
            let params = data
                .get("params")
                .cloned()
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({}));
            self.codex_app_server
                .request(&method, params)
                .await
                .map_err(|error| AppIpcError::new("codex_app_server_request_failed", error))
        })
    }
}

fn is_allowed_plugin_app_server_method(method: &str) -> bool {
    matches!(
        method,
        "marketplace/add"
            | "marketplace/remove"
            | "marketplace/upgrade"
            | "plugin/list"
            | "plugin/installed"
            | "plugin/read"
            | "plugin/skill/read"
            | "plugin/install"
            | "plugin/uninstall"
            | "skills/list"
            | "skills/config/write"
            | "app/list"
    )
}

#[cfg(debug_assertions)]
const SLOW_RUNTIME_COLLECT_THREAD_MS: u128 = 100;

#[cfg(debug_assertions)]
fn log_runtime_collect_diagnostic(
    stage: &str,
    archived: bool,
    started_at: Instant,
    stage_started_at: Instant,
    fields: &[(&str, String)],
) {
    let mut diagnostic_fields = vec![
        ("stage", stage.to_owned()),
        ("archived", archived.to_string()),
        ("elapsed_ms", elapsed_ms(started_at)),
        ("stage_elapsed_ms", elapsed_ms(stage_started_at)),
    ];
    if let Some(rss_kb) = current_process_max_rss_kb() {
        diagnostic_fields.push(("max_rss_kb", rss_kb.to_string()));
    }
    diagnostic_fields.extend(fields.iter().map(|(key, value)| (*key, value.clone())));
    log_executor_event("runtime work collect diagnostic", &diagnostic_fields);
}

#[cfg(not(debug_assertions))]
fn log_runtime_collect_diagnostic(
    _stage: &str,
    _archived: bool,
    _started_at: Instant,
    _stage_started_at: Instant,
    _fields: &[(&str, String)],
) {
}

#[cfg(debug_assertions)]
fn log_slow_runtime_collect_thread(
    archived: bool,
    thread_id: &str,
    started_at: Instant,
    thread: &Value,
    link: &RuntimeTaskLink,
) {
    let elapsed = started_at.elapsed().as_millis();
    if elapsed < SLOW_RUNTIME_COLLECT_THREAD_MS {
        return;
    }
    log_executor_event(
        "runtime work collect slow thread",
        &[
            ("archived", archived.to_string()),
            ("elapsed_ms", elapsed.to_string()),
            ("thread_id", thread_id.to_owned()),
            ("thread_json_bytes", debug_json_len(thread).to_string()),
            ("local_task_id", link.local_task_id.clone()),
            ("workspace_path", link.workspace_path.clone()),
            ("status", link.status.clone()),
        ],
    );
}

#[cfg(not(debug_assertions))]
fn log_slow_runtime_collect_thread(
    _archived: bool,
    _thread_id: &str,
    _started_at: Instant,
    _thread: &Value,
    _link: &RuntimeTaskLink,
) {
}

#[cfg(debug_assertions)]
fn log_slow_runtime_collect_thread_missing(
    archived: bool,
    thread_id: &str,
    started_at: Instant,
    thread: &Value,
) {
    let elapsed = started_at.elapsed().as_millis();
    if elapsed < SLOW_RUNTIME_COLLECT_THREAD_MS {
        return;
    }
    log_executor_event(
        "runtime work collect slow skipped thread",
        &[
            ("archived", archived.to_string()),
            ("elapsed_ms", elapsed.to_string()),
            ("thread_id", thread_id.to_owned()),
            ("thread_json_bytes", debug_json_len(thread).to_string()),
        ],
    );
}

#[cfg(not(debug_assertions))]
fn log_slow_runtime_collect_thread_missing(
    _archived: bool,
    _thread_id: &str,
    _started_at: Instant,
    _thread: &Value,
) {
}

#[cfg(debug_assertions)]
fn debug_json_len(value: &Value) -> usize {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or_default()
}

#[cfg(debug_assertions)]
fn log_runtime_work_list_diagnostic(
    stage: &str,
    started_at: Instant,
    stage_started_at: Instant,
    fields: &[(&str, String)],
) {
    let mut diagnostic_fields = vec![
        ("stage", stage.to_owned()),
        ("elapsed_ms", elapsed_ms(started_at)),
        ("stage_elapsed_ms", elapsed_ms(stage_started_at)),
    ];
    if let Some(rss_kb) = current_process_max_rss_kb() {
        diagnostic_fields.push(("max_rss_kb", rss_kb.to_string()));
    }
    diagnostic_fields.extend(fields.iter().map(|(key, value)| (*key, value.clone())));
    log_executor_event("runtime work list diagnostic", &diagnostic_fields);
}

#[cfg(not(debug_assertions))]
fn log_runtime_work_list_diagnostic(
    _stage: &str,
    _started_at: Instant,
    _stage_started_at: Instant,
    _fields: &[(&str, String)],
) {
}

#[cfg(debug_assertions)]
fn current_process_max_rss_kb() -> Option<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return None;
    }
    let max_rss = unsafe { usage.assume_init().ru_maxrss };
    #[cfg(target_os = "macos")]
    {
        Some((max_rss as u64).saturating_div(1024))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Some(max_rss as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finishing_an_active_goal_keeps_the_task_idle() {
        let index_path = temp_runtime_work_index_path("finish-active-goal");
        let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
        handler.store = RuntimeWorkStore::new(index_path.clone());
        let mut link = RuntimeTaskLink::new_pending(
            "task-1".to_owned(),
            "/tmp/project".to_owned(),
            "Task".to_owned(),
        );
        link.goal_status = Some("active".to_owned());
        handler.upsert_local_task(link);

        handler.finish_local_task("task-1", Some("thread-1".to_owned()), "done");

        let task = handler
            .local_task_link("task-1")
            .expect("task should remain stored");
        assert_eq!(task.status, "done");
        assert!(!task.running);
        assert_eq!(task.goal_status.as_deref(), Some("active"));

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn syncing_an_active_goal_does_not_start_an_idle_task() {
        let index_path = temp_runtime_work_index_path("sync-active-goal");
        let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
        handler.store = RuntimeWorkStore::new(index_path.clone());
        let mut link = RuntimeTaskLink::new_pending(
            "task-1".to_owned(),
            "/tmp/project".to_owned(),
            "Task".to_owned(),
        );
        link.status = "done".to_owned();
        link.running = false;
        handler.upsert_local_task(link);

        handler.sync_runtime_task_goal_status("task-1", Some("active".to_owned()));

        let task = handler
            .local_task_link("task-1")
            .expect("task should remain stored");
        assert_eq!(task.status, "done");
        assert!(!task.running);
        assert_eq!(task.goal_status.as_deref(), Some("active"));

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn current_codex_model_provider_reads_configured_provider_name() {
        let provider = current_codex_model_provider_from_config(&json!({
            "config": {
                "model_provider": "wecode-openai",
                "model_providers": {
                    "wecode-openai": {
                        "name": "wecode openai"
                    },
                    "wecode-ark": {
                        "name": "wecode ark"
                    }
                }
            }
        }));

        assert_eq!(provider.id, "wecode-openai");
        assert_eq!(provider.display_name, "wecode openai");
        assert_eq!(provider.kind, "provider");
        assert!(provider.current);
    }

    #[test]
    fn current_codex_model_provider_defaults_to_official() {
        let provider = current_codex_model_provider_from_config(&json!({"config": {}}));

        assert_eq!(provider.id, "openai");
        assert_eq!(provider.display_name, "CodeX");
        assert_eq!(provider.kind, "official");
        assert!(provider.current);
    }

    #[test]
    fn runtime_session_ids_only_accept_codex_uuid_thread_ids() {
        assert!(is_codex_thread_id("019f4c0d-b036-78f3-b879-7e5ed203ad61"));
        assert!(is_codex_thread_id(
            "urn:uuid:019f4c0d-b036-78f3-b879-7e5ed203ad61"
        ));
        assert!(!is_codex_thread_id("runtime-481327491"));
        assert!(!is_codex_thread_id("thread-1"));

        let mut link = RuntimeTaskLink::new_pending(
            "runtime-481327491".to_owned(),
            "/tmp/project".to_owned(),
            "Task".to_owned(),
        );
        link.thread_id = Some(link.local_task_id.clone());
        assert_eq!(
            runtime_session_id_from_link(&link).as_deref(),
            Some("runtime-481327491")
        );
        assert_eq!(codex_thread_id_from_link(&link), None);
    }

    #[test]
    fn plugin_app_server_method_allowlist_covers_wework_plugin_runtime_surface() {
        for method in [
            "marketplace/add",
            "marketplace/remove",
            "marketplace/upgrade",
            "plugin/list",
            "plugin/installed",
            "plugin/read",
            "plugin/skill/read",
            "plugin/install",
            "plugin/uninstall",
            "skills/list",
            "skills/config/write",
            "app/list",
        ] {
            assert!(
                is_allowed_plugin_app_server_method(method),
                "{method} should be allowed"
            );
        }

        assert!(!is_allowed_plugin_app_server_method("thread/new"));
        assert!(!is_allowed_plugin_app_server_method("plugin/share/save"));
    }

    #[test]
    fn cached_user_message_uses_explicit_payload_text() {
        let request = ExecutionRequest {
            subtask_id: "42".to_owned(),
            prompt: json!([
                {"type": "input_text", "text": "# AGENTS.md instructions\n\n<environment_context>"},
                {"type": "input_text", "text": "visible user text"}
            ]),
            ..ExecutionRequest::default()
        };

        let message = cached_user_message(
            "local-task",
            &request,
            &json!({"message": "visible user text"}),
        )
        .expect("payload message should create a cached user message");

        assert_eq!(message["content"], "visible user text");

        let content_message = cached_user_message(
            "local-task",
            &request,
            &json!({"content": "visible content text"}),
        )
        .expect("payload content should create a cached user message");

        assert_eq!(content_message["content"], "visible content text");
    }

    #[test]
    fn cached_user_message_does_not_fallback_to_prompt() {
        let request = ExecutionRequest {
            subtask_id: "42".to_owned(),
            prompt: json!([
                {"type": "input_text", "text": "# AGENTS.md instructions\n\n<environment_context>"}
            ]),
            ..ExecutionRequest::default()
        };

        assert!(cached_user_message("local-task", &request, &json!({})).is_none());
    }

    #[test]
    fn transcript_appends_cached_user_message_missing_from_failed_provider_turn() {
        let mut provider_messages = vec![
            json!({"id": "user-1", "role": "user", "content": "first"}),
            json!({"id": "assistant-1", "role": "assistant", "content": "done"}),
        ];
        let cached_messages = vec![
            json!({"id": "cached-user-1", "role": "user", "content": "first"}),
            json!({"id": "cached-user-2", "role": "user", "content": "retry this"}),
        ];

        append_missing_cached_user_messages(&mut provider_messages, cached_messages);

        assert_eq!(provider_messages.len(), 3);
        assert_eq!(provider_messages[2]["id"], "cached-user-2");
        assert_eq!(provider_messages[2]["content"], "retry this");
    }

    #[test]
    fn transcript_does_not_duplicate_cached_user_messages_already_from_provider() {
        let mut provider_messages = vec![
            json!({"id": "user-1", "role": "user", "content": "same"}),
            json!({"id": "user-2", "role": "user", "content": "same"}),
        ];
        let cached_messages = vec![
            json!({"id": "cached-user-1", "role": "user", "content": "same"}),
            json!({"id": "cached-user-2", "role": "user", "content": "same"}),
        ];

        append_missing_cached_user_messages(&mut provider_messages, cached_messages);

        assert_eq!(provider_messages.len(), 2);
    }

    #[tokio::test]
    async fn codex_stream_debug_rpc_toggles_runtime_flag() {
        set_codex_stream_debug_enabled(false);
        let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

        let initial = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.codex.stream_debug.get",
                "payload": {}
            }))
            .await
            .expect("debug state should return");
        assert_eq!(initial["enabled"], false);

        let updated = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.codex.stream_debug.set",
                "payload": {"enabled": true}
            }))
            .await
            .expect("debug state should update");
        assert_eq!(updated["enabled"], true);
        assert!(codex_stream_debug_enabled());

        set_codex_stream_debug_enabled(false);
    }

    #[tokio::test]
    async fn codex_app_server_restart_rpc_returns_success() {
        let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

        let result = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.codex.app_server.restart",
                "payload": {}
            }))
            .await
            .expect("restart should return success");

        assert_eq!(result["restarted"], true);
    }

    #[tokio::test]
    async fn codex_instructions_write_rejects_non_string_payload() {
        let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

        let result = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.codex.instructions.write",
                "payload": {"instructions": 1}
            }))
            .await;

        let error = result.expect_err("non-string instructions should be rejected");
        assert_eq!(error.code, "invalid_request");
    }

    #[tokio::test]
    async fn codex_personality_write_rejects_unsupported_value() {
        let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

        let result = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.codex.personality.write",
                "payload": {"personality": "default"}
            }))
            .await;

        let error = result.expect_err("unsupported personality should be rejected");
        assert_eq!(error.code, "invalid_request");
    }

    #[test]
    fn codex_developer_instructions_preserve_user_copy_and_browser_routing() {
        let combined = combined_codex_developer_instructions("用中文回复");

        assert!(combined.contains("用中文回复"));
        assert!(combined.contains("browser_navigate"));
        assert!(combined.contains("Wework built-in browser"));
        assert_eq!(strip_wework_browser_instructions(&combined), "用中文回复");
    }

    #[tokio::test]
    async fn transcript_without_runtime_link_returns_empty_local_transcript() {
        let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

        let result = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.tasks.transcript",
                "payload": {
                    "taskId": "optimistic-local-task",
                    "workspacePath": "/tmp/project"
                }
            }))
            .await
            .expect("missing runtime link should not read provider session");

        assert_eq!(result["success"], true);
        assert_eq!(result["taskId"], "optimistic-local-task");
        assert_eq!(result["workspacePath"], "/tmp/project");
        assert_eq!(result["messages"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn first_message_search_result_returns_bounded_snippet() {
        let link = RuntimeTaskLink::new_pending(
            "local-task-1".to_owned(),
            "/tmp/project".to_owned(),
            "Long message task".to_owned(),
        );
        let content = format!("{}needle{}", "a".repeat(300), "b".repeat(300));

        let result = first_message_search_result(
            &link,
            "device-1",
            vec![json!({
                "id": "message-1",
                "role": "user",
                "content": content,
                "createdAt": 1780000000,
            })],
            "needle",
        )
        .expect("long matching message should produce a result");
        let snippet = result["snippet"].as_str().unwrap();
        let match_start = result["matchStart"].as_u64().unwrap() as usize;
        let match_end = result["matchEnd"].as_u64().unwrap() as usize;

        assert!(snippet.len() < 300);
        assert!(snippet.contains("needle"));
        assert_eq!(&snippet[match_start..match_end], "needle");
    }

    #[test]
    fn pending_thread_event_route_promotes_on_thread_started() {
        let index_path = temp_runtime_work_index_path("pending-thread-event-route");
        let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
        handler.store = RuntimeWorkStore::new(index_path.clone());
        let local_task_id = "local-task-1".to_owned();
        let request = ExecutionRequest {
            task_id: "1".to_owned(),
            subtask_id: "42".to_owned(),
            ..ExecutionRequest::default()
        };
        handler.upsert_local_task(RuntimeTaskLink::new_pending(
            local_task_id.clone(),
            "/tmp/project".to_owned(),
            "Pending route".to_owned(),
        ));

        handler.register_pending_thread_event_route(local_task_id.clone(), request);

        assert!(!handler.thread_event_route_exists("thread-1"));
        assert!(handler.promote_pending_thread_event_route("thread-1"));
        assert!(handler.thread_event_route_exists("thread-1"));
        let link = handler
            .local_task_link(&local_task_id)
            .expect("local task should be stored");
        assert_eq!(link.thread_id.as_deref(), Some("thread-1"));

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn cached_codex_link_stays_visible_until_provider_thread_is_discovered() {
        let mut link = RuntimeTaskLink::new_pending(
            "local-task-1".to_owned(),
            "/Users/test/Documents/Codex/2026-07-07/hi".to_owned(),
            "hi".to_owned(),
        );
        link.thread_id = Some("thread-1".to_owned());
        link.running = false;
        link.status = "active".to_owned();

        assert!(!is_cached_codex_link_hidden(&link, &HashSet::new()));

        let discovered_thread_ids = HashSet::from(["thread-1".to_owned()]);
        assert!(is_cached_codex_link_hidden(&link, &discovered_thread_ids));
    }

    #[tokio::test]
    async fn create_task_stores_model_selection_in_runtime_handle() {
        let index_path = temp_runtime_work_index_path("create-task-model-selection");
        let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
        handler.store = RuntimeWorkStore::new(index_path.clone());

        let response = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.tasks.create",
                "payload": {
                    "taskId": "local-task-1",
                    "workspacePath": "/tmp/project",
                    "title": "Use mimo",
                    "modelId": "local-model:mimo",
                    "modelType": "runtime",
                    "modelOptions": {
                        "collaborationMode": "plan"
                    },
                    "modelSelection": {
                        "modelName": "cloud:user:local-model:mimo",
                        "modelType": "user",
                        "options": {
                            "collaborationMode": "plan",
                            "reasoningEffort": "high"
                        }
                    },
                    "executionRequest": serde_json::to_value(ExecutionRequest::default()).unwrap()
                }
            }))
            .await
            .expect("runtime task should be created");
        assert_eq!(
            response["runtimeHandle"]["modelSelection"],
            json!({
                "modelName": "cloud:user:local-model:mimo",
                "modelType": "user",
                "options": {
                    "collaborationMode": "plan",
                    "reasoningEffort": "high"
                }
            })
        );

        let link = handler
            .local_task_link("local-task-1")
            .expect("created task should be stored");
        assert_eq!(
            link.runtime_handle["modelSelection"],
            json!({
                "modelName": "cloud:user:local-model:mimo",
                "modelType": "user",
                "options": {
                    "collaborationMode": "plan",
                    "reasoningEffort": "high"
                }
            })
        );

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn model_selection_falls_back_to_execution_model_for_legacy_requests() {
        let mut runtime_handle = json!({});

        set_runtime_handle_model_selection(
            &mut runtime_handle,
            &json!({
                "modelId": "legacy-model",
                "modelType": "runtime",
                "modelOptions": {"reasoningEffort": "medium"}
            }),
        );

        assert_eq!(
            runtime_handle["modelSelection"],
            json!({
                "modelName": "legacy-model",
                "modelType": "runtime",
                "options": {"reasoningEffort": "medium"}
            })
        );
    }

    #[test]
    fn active_local_task_skips_global_notification_route() {
        let (event_tx, mut event_rx) = broadcast::channel(8);
        let index_path = temp_runtime_work_index_path("active-local-task-route");
        let mut handler =
            RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
        handler.store = RuntimeWorkStore::new(index_path.clone());
        let local_task_id = "runtime-task-1";
        let request = ExecutionRequest {
            task_id: local_task_id.to_owned(),
            subtask_id: "runtime-subtask-1".to_owned(),
            ..ExecutionRequest::default()
        };
        let mut link = RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            "/tmp/project".to_owned(),
            "Task".to_owned(),
        );
        link.thread_id = Some("thread-1".to_owned());
        handler.upsert_local_task(link);
        handler.mark_active_local_task(local_task_id);
        handler.register_thread_event_route("thread-1", local_task_id.to_owned(), request, true);

        handler.route_codex_notification(json!({
            "method": "item/agentMessage/delta",
            "params": {
                "delta": "Hi",
                "itemId": "msg-1",
                "threadId": "thread-1",
                "turnId": "turn-1"
            }
        }));

        assert!(event_rx.try_recv().is_err());

        handler.unmark_active_local_task(local_task_id);
        handler.route_codex_notification(json!({
            "method": "item/agentMessage/delta",
            "params": {
                "delta": "Hi",
                "itemId": "msg-1",
                "threadId": "thread-1",
                "turnId": "turn-1"
            }
        }));

        let event = event_rx
            .try_recv()
            .expect("idle route should emit notification");
        assert_eq!(event["event"], "response.output_text.delta");
        assert_eq!(event["payload"]["taskId"], local_task_id);
        assert_eq!(event["payload"]["subtaskId"], "runtime-subtask-1");
        assert_eq!(event["payload"]["data"]["delta"], "Hi");

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn archived_cleanup_targets_include_managed_worktree_and_local_attachment() {
        let mut link = RuntimeTaskLink::new_pending(
            "task-1".to_owned(),
            "/Users/me/.wegent-executor/workspace/worktrees/task-1/Wegent".to_owned(),
            "Task".to_owned(),
        );
        link.runtime_handle = json!({
            "messages": [
                {
                    "attachments": [
                        {
                            "local_path": "/Users/me/.wegent-executor/workspace/attachments/draft/1/photo.png"
                        }
                    ]
                }
            ]
        });

        let targets = cleanup_targets_for_task(&link);
        let target_paths = targets
            .iter()
            .map(|target| target.path.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert!(target_paths
            .contains(&"/Users/me/.wegent-executor/workspace/worktrees/task-1/Wegent".to_owned()));
        assert!(target_paths.contains(
            &"/Users/me/.wegent-executor/workspace/attachments/draft/1/photo.png".to_owned()
        ));
    }

    #[test]
    fn guidance_inputs_include_only_local_images() {
        let attachments = json!([
            {
                "mime_type": "image/png",
                "local_path": "/tmp/screenshot.png"
            },
            {
                "mime_type": "text/plain",
                "local_path": "/tmp/notes.txt"
            },
            {
                "mime_type": "image/jpeg"
            }
        ]);

        assert_eq!(
            guidance_image_inputs(Some(&attachments)),
            vec![json!({
                "type": "localImage",
                "path": "/tmp/screenshot.png"
            })]
        );
        assert_eq!(
            guidance_input_items("", Some(&attachments)),
            vec![json!({
                "type": "localImage",
                "path": "/tmp/screenshot.png"
            })]
        );
        assert!(guidance_input_items("", None).is_empty());
    }

    #[test]
    fn codex_guidance_turn_races_are_reported_as_no_active_turn() {
        assert_eq!(
            codex_guidance_failure_code("no active turn to steer"),
            "no_active_turn"
        );
        assert_eq!(
            codex_guidance_failure_code("expected active turn id `turn-1` but found `turn-2`"),
            "no_active_turn"
        );
        assert_eq!(
            codex_guidance_failure_code("turn/steer response missing turnId"),
            "guidance_failed"
        );
    }

    #[test]
    fn archived_cleanup_targets_do_not_delete_regular_project_root() {
        let link = RuntimeTaskLink::new_pending(
            "task-1".to_owned(),
            "/Users/me/project".to_owned(),
            "Task".to_owned(),
        );

        let targets = cleanup_targets_for_task(&link);
        let target_paths = targets
            .iter()
            .map(|target| target.path.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert!(!target_paths.contains(&"/Users/me/project".to_owned()));
        assert!(target_paths.contains(&"/Users/me/project/.wegent/attachments/task-1".to_owned()));
        assert!(target_paths.contains(&"/Users/me/project/task-1:executor:attachments".to_owned()));
    }

    fn temp_runtime_work_index_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "wegent-runtime-work-{label}-{}-{}.json",
            std::process::id(),
            now_ms()
        ))
    }
}
