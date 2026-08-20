// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{HashMap, HashSet, VecDeque},
    env, fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};

use chrono::Local;
use futures_util::{stream, StreamExt};
use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex as AsyncMutex};
use tokio::time::sleep;

use crate::{
    agents::{
        codex_runtime_approval_policy, select_wework_codex_user_instructions, AgentCommandPlanner,
        AgentProcessEngine, CodexActiveTurnCallback, CodexActiveTurnFinishedCallback,
        CodexAppServerClient, CodexAppServerTurnOptions, CodexRequestUserInputReceiver,
        CodexThreadStartedCallback, CODEX_APP_SERVER_TURN_CANCELLED,
        CODEX_DANGER_FULL_ACCESS_PERMISSION_PROFILE, CODEX_READ_ONLY_PERMISSION_PROFILE,
        CODEX_WORKSPACE_PERMISSION_PROFILE,
    },
    config::device::ConnectionConfig,
    hooks::{
        codex::{post_tool_use_from_notification, CodexHookContext},
        host::HookService,
        model::HookUser,
    },
    local::app_ipc::{AppIpcError, RuntimeWorkHandler},
    logging::log_executor_event,
    protocol::ExecutionRequest,
    runner::ExecutionOutcome,
    server::{executor_loopback_base_url, harness_context, local_model_proxy},
};

const WORKTREE_RECONCILIATION_RETRY_INTERVAL: Duration = Duration::from_secs(5);

mod archives;
mod automation_rpc;
mod claude_turns;
mod codex_config;
mod collection;
mod fork_transfer;
mod hooks;
mod notifications;
mod queries;
mod robot_queue_rpc;
mod sidebar;
mod supervisor;
mod system;
mod tasks;
mod turns;
mod workspaces;

use super::{
    automations::{AutomationRunStatus, AutomationStore},
    codex_global_state::{
        activate_codex_global_project, open_codex_global_project,
        register_codex_global_thread_workspace_root, remove_codex_global_project,
        rename_codex_global_project, reorder_codex_global_project_thread,
        reorder_codex_global_projects, set_codex_global_project_appearance,
        set_codex_global_project_pinned, set_codex_global_thread_pinned,
        sync_codex_global_remote_projects, upsert_codex_global_local_project,
        CodexGlobalProjectIndex, CodexGlobalRemoteProject,
    },
    codex_notifications::{codex_notification, is_root_codex_turn_event},
    codex_rollout::rollout_context_usage,
    codex_transcript_page::{
        load_codex_transcript, CodexTranscriptDirection, CodexTranscriptPage,
        CodexTranscriptRequest,
    },
    connectors::ConnectorRuntime,
    events::{emit_response_event, is_context_compaction_request, CodexNotificationEventMapper},
    notification_mapping::{codex_stream_debug_enabled, set_codex_stream_debug_enabled},
    response::{
        archived_conversations_response, codex_thread_has_in_progress_turn,
        codex_thread_in_progress_turn_id, runtime_status_is_running, search_result_item,
        workspace_response, RuntimeTaskLink, RuntimeWorkspaceLink, SearchResultMatch,
    },
    runtime_handle_messages::{
        append_runtime_handle_message, append_runtime_handle_user_message_presentation,
        cached_messages, clear_runtime_handle_messages, set_runtime_handle_messages,
        user_message_presentations,
    },
    store::{runtime_work_dir, RuntimeWorkStore},
    transcript::{
        full_transcript_messages, normalized_user_request_content, notification_item,
        transcript_messages,
    },
    transcript_page::transcript_page,
    util::{
        apply_runtime_payload_metadata, bool_field, cloud_project_id, execution_request, id_field,
        infer_workspace_kind, integer_field, is_codex_context_compaction_item_type, item_id,
        item_type, normalize_device_id, normalize_workspace_path, now_ms, prompt_text,
        restore_cloud_project_id, restore_origin, runtime_task_id, string_field,
        timestamp_ms_field, workspace_group_path, workspace_path,
    },
    worktrees::{WorktreeManager, WorktreeSettingsPatch},
};

const CODEX_THREAD_LIST_PAGE_SIZE: usize = 100;
const CODEX_THREAD_LIST_MAX_ITEMS: usize = 500;
const CODEX_THREAD_SOURCE_KINDS: &[&str] = &["cli", "vscode", "exec", "appServer"];
const PENDING_THREAD_EVENT_ROUTE_PREFIX: &str = "pending:";
const ACTIVE_CODEX_TURN_WAIT_ATTEMPTS: usize = 20;
const ACTIVE_CODEX_TURN_WAIT_MS: u64 = 50;
const CODEX_TRANSCRIPT_PAGE_SIZE: usize = 40;
const PROVIDER_TURN_INTERRUPT_WAIT_ATTEMPTS: usize = 100;
const CONTEXT_COMPACTION_WAIT_ATTEMPTS: usize = 600;
const CONTEXT_COMPACTION_WAIT_MS: u64 = 200;
const PROVIDER_TURN_INTERRUPT_WAIT_MS: u64 = 100;
const TRANSCRIPT_NAVIGATION_PREVIEW_CHARS: usize = 96;
const SEARCH_SNIPPET_CONTEXT_CHARS: usize = 80;
const SEARCH_SNIPPET_MAX_CHARS: usize = 240;
const ARCHIVED_BACKGROUND_THREAD_DELETE_SLOW_THRESHOLD: Duration = Duration::from_secs(5);
const ARCHIVED_BACKGROUND_DELETE_INTERVAL: Duration = Duration::from_millis(250);
const WORKTREE_AUTO_CLEANUP_IDLE_DELAY: Duration = Duration::from_secs(5 * 60);
const WORKTREE_AUTO_CLEANUP_BATCH_DELAY: Duration = Duration::from_secs(30);
const WORKTREE_AUTO_CLEANUP_ERROR_DELAY: Duration = Duration::from_secs(5 * 60);
const WORKTREE_AUTO_CLEANUP_MAX_EMPTY_ROUNDS: usize = 3;
const CODEX_OFFICIAL_PROVIDER_ID: &str = "openai";
const CODEX_OFFICIAL_PROVIDER_NAME: &str = "CodeX";
const DEFAULT_MAX_CONCURRENT_TASKS: usize = 10;
const MIN_MAX_CONCURRENT_TASKS: usize = 1;
const MAX_MAX_CONCURRENT_TASKS: usize = 20;

fn worktree_error_code(error: &str) -> &'static str {
    [
        "worktree_source_missing",
        "worktree_source_not_git",
        "worktree_source_changed",
        "worktree_root_unwritable",
        "worktree_git_common_dir_unwritable",
        "worktree_ref_not_found",
        "worktree_target_conflict",
        "worktree_device_mismatch",
        "worktree_persistent_storage_unverified",
    ]
    .into_iter()
    .find(|code| error.starts_with(&format!("{code}:")))
    .unwrap_or("worktree_prepare_failed")
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SpawnTurnRequest {
    local_task_id: String,
    #[serde(default = "default_turn_runtime")]
    runtime: String,
    request: ExecutionRequest,
    direct_thread_id: Option<String>,
    fork_thread_id: Option<String>,
    fork_thread_path: Option<String>,
    resume_thread_id: Option<String>,
    initial_thread_name: Option<String>,
    initial_thread_goal: Option<Value>,
}

fn default_turn_runtime() -> String {
    "codex".to_owned()
}

#[derive(Clone)]
struct RuntimeTurnScheduler {
    max_concurrent_tasks: usize,
    active_tasks: usize,
    active_task_ids: HashSet<String>,
    queued_turns: VecDeque<SpawnTurnRequest>,
}

impl RuntimeTurnScheduler {
    fn new(max_concurrent_tasks: usize, queued_turns: VecDeque<SpawnTurnRequest>) -> Self {
        Self {
            max_concurrent_tasks,
            active_tasks: 0,
            active_task_ids: HashSet::new(),
            queued_turns,
        }
    }

    fn enqueue(&mut self, turn: SpawnTurnRequest) -> Option<SpawnTurnRequest> {
        if self.active_tasks >= self.max_concurrent_tasks || !self.queued_turns.is_empty() {
            self.queued_turns.push_back(turn);
            return None;
        }
        self.active_tasks += 1;
        self.active_task_ids.insert(turn.local_task_id.clone());
        Some(turn)
    }

    fn queued_position(&self, local_task_id: &str) -> Option<usize> {
        self.queued_turns
            .iter()
            .position(|turn| turn.local_task_id == local_task_id)
    }

    fn reordered_queue(
        &self,
        local_task_id: &str,
        target_position: usize,
    ) -> Result<VecDeque<SpawnTurnRequest>, &'static str> {
        let current_position = self
            .queued_position(local_task_id)
            .ok_or("runtime task is not queued")?;
        let mut reordered = self.queued_turns.clone();
        let turn = reordered
            .remove(current_position)
            .ok_or("queued runtime task disappeared")?;
        reordered.insert(target_position.saturating_sub(1).min(reordered.len()), turn);
        Ok(reordered)
    }

    fn finish(&mut self, local_task_id: &str) -> Vec<SpawnTurnRequest> {
        self.active_task_ids.remove(local_task_id);
        self.active_tasks = self.active_task_ids.len();
        self.take_available()
    }

    fn force_start(&mut self, local_task_id: &str) -> Option<SpawnTurnRequest> {
        let position = self
            .queued_turns
            .iter()
            .position(|turn| turn.local_task_id == local_task_id)?;
        let turn = self.queued_turns.remove(position)?;
        self.active_tasks += 1;
        self.active_task_ids.insert(turn.local_task_id.clone());
        Some(turn)
    }

    fn update_limit(&mut self, max_concurrent_tasks: usize) -> Vec<SpawnTurnRequest> {
        self.max_concurrent_tasks = max_concurrent_tasks;
        self.take_available()
    }

    fn take_available(&mut self) -> Vec<SpawnTurnRequest> {
        let available = self.max_concurrent_tasks.saturating_sub(self.active_tasks);
        let turns = (0..available)
            .filter_map(|_| self.queued_turns.pop_front())
            .collect::<Vec<_>>();
        self.active_task_ids
            .extend(turns.iter().map(|turn| turn.local_task_id.clone()));
        self.active_tasks += turns.len();
        turns
    }
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(default, rename_all = "camelCase")]
struct RuntimeSettings {
    max_concurrent_tasks: usize,
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        Self {
            max_concurrent_tasks: DEFAULT_MAX_CONCURRENT_TASKS,
        }
    }
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
        .filter(|provider| {
            provider != crate::server::codex_model_catalog::PROVIDER_ID
                && provider != "wework-catalog"
        })
        .unwrap_or_else(crate::agents::configured_inference_model_provider);
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

fn hook_payload<T: serde::de::DeserializeOwned>(
    payload: &Value,
    key: &str,
) -> Result<T, AppIpcError> {
    let value = payload
        .get(key)
        .cloned()
        .ok_or_else(|| AppIpcError::new("bad_request", format!("{key} is required")))?;
    serde_json::from_value(value)
        .map_err(|error| AppIpcError::new("bad_request", format!("invalid {key}: {error}")))
}

fn hook_rpc_error(error: String) -> AppIpcError {
    AppIpcError::new("hook_error", error)
}

#[derive(Clone)]
pub struct RuntimeWorkRpcHandler {
    device_id: String,
    codex_app_server: CodexAppServerClient,
    claude_process_engine: AgentProcessEngine,
    codex_runtime_proxy_config: Arc<AsyncMutex<CodexRuntimeProxyConfig>>,
    event_tx: Option<broadcast::Sender<Value>>,
    next_execution_id: Arc<AtomicU64>,
    task_send_gates: Arc<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>>,
    turn_scheduler: Arc<Mutex<RuntimeTurnScheduler>>,
    turn_queue_operation: Arc<AsyncMutex<()>>,
    turn_queue_path: Arc<PathBuf>,
    interrupted_worktree_turns: Arc<AsyncMutex<Option<VecDeque<SpawnTurnRequest>>>>,
    preparing_worktree_turns: Arc<Mutex<HashMap<String, PreparingWorktreeTurn>>>,
    active_turn_cancellations: Arc<Mutex<HashMap<String, ActiveTurnCancellation>>>,
    active_codex_turns: Arc<Mutex<HashMap<String, ActiveCodexTurn>>>,
    active_codex_transcript_items: Arc<Mutex<HashMap<String, ActiveCodexTranscriptItems>>>,
    active_request_user_inputs: Arc<Mutex<HashMap<String, ActiveRequestUserInput>>>,
    supervisor_evaluating: Arc<Mutex<HashSet<String>>>,
    supervisor_model_configs: Arc<Mutex<HashMap<String, Value>>>,
    thread_event_routes: Arc<Mutex<HashMap<String, RuntimeThreadEventRoute>>>,
    notification_router: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    archived_delete_tx: mpsc::UnboundedSender<RuntimeTaskLink>,
    automation_store: AutomationStore,
    store: RuntimeWorkStore,
    worktrees: WorktreeManager,
    worktree_reconciliation_state: Arc<AsyncMutex<WorktreeReconciliationState>>,
    worktree_cleanup_generation: Arc<AtomicU64>,
    opened_workspace_roots: Arc<Mutex<HashSet<PathBuf>>>,
    hook_service: HookService,
    connectors: ConnectorRuntime,
    /// Authoritative backend connection configuration (URL + auth tokens)
    /// updated by `executor.backend.configure`. Runtime task payloads do not
    /// carry credentials, so turns fill them from here before launching the
    /// project-space MCP server.
    backend_connection: Arc<Mutex<Option<ConnectionConfig>>>,
}

#[derive(Default)]
struct CodexRuntimeProxyConfig {
    initialized: bool,
    proxy_url: Option<String>,
}

#[derive(Default)]
struct WorktreeReconciliationState {
    completed: bool,
    last_attempt: Option<Instant>,
}

struct ActiveTurnCancellation {
    execution_id: u64,
    stop_requested: bool,
    cancel: oneshot::Sender<()>,
    stopped: oneshot::Receiver<()>,
}

#[derive(Debug, PartialEq, Eq)]
struct PreparingWorktreeTurn {
    cancellation_requested: bool,
}

#[derive(Clone)]
struct ActiveRequestUserInput {
    execution_id: u64,
    sender: mpsc::Sender<Value>,
}

#[derive(Clone)]
struct ActiveCodexTurn {
    execution_id: u64,
    thread_id: String,
    turn_id: String,
}

#[derive(Clone)]
struct ActiveCodexTranscriptItems {
    turn_id: String,
    items: Vec<Value>,
}

struct RuntimeThreadEventRoute {
    local_task_id: String,
    request: ExecutionRequest,
    event_mapper: CodexNotificationEventMapper,
    active: bool,
}

struct ScheduledTurnGuard {
    handler: RuntimeWorkRpcHandler,
    local_task_id: String,
}

struct StoppedTurnGuard {
    sender: Option<oneshot::Sender<()>>,
}

impl StoppedTurnGuard {
    fn new(sender: oneshot::Sender<()>) -> Self {
        Self {
            sender: Some(sender),
        }
    }
}

impl Drop for StoppedTurnGuard {
    fn drop(&mut self) {
        if let Some(sender) = self.sender.take() {
            let _ = sender.send(());
        }
    }
}

impl ScheduledTurnGuard {
    fn new(handler: RuntimeWorkRpcHandler, local_task_id: String) -> Self {
        Self {
            handler,
            local_task_id,
        }
    }
}

impl Drop for ScheduledTurnGuard {
    fn drop(&mut self) {
        let handler = self.handler.clone();
        let local_task_id = self.local_task_id.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                handler.finish_scheduled_turn(&local_task_id).await;
            });
        }
    }
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
        let device_id = normalize_device_id(device_id.into());
        let (archived_delete_tx, archived_delete_rx) = mpsc::unbounded_channel();
        let codex_app_server = CodexAppServerClient::new(codex_binary);
        let runtime_settings = system::read_runtime_settings();
        let store = RuntimeWorkStore::from_env();
        let worktrees = WorktreeManager::from_env(&device_id);
        let turn_queue_path = turns::runtime_turn_queue_path();
        let restored_turns =
            turns::read_runtime_turn_queue(&turn_queue_path).unwrap_or_else(|error| {
                log_executor_event("runtime turn queue restore failed", &[("error", error)]);
                VecDeque::new()
            });
        let (queued_turns, interrupted_worktree_turns) =
            turns::partition_restored_turns(&worktrees, restored_turns);
        if !interrupted_worktree_turns.is_empty() {
            log_executor_event(
                "persisted worktree turns quarantined after executor restart",
                &[("count", interrupted_worktree_turns.len().to_string())],
            );
        }
        let handler = Self {
            device_id,
            connectors: ConnectorRuntime::new(codex_app_server.clone()),
            codex_app_server,
            claude_process_engine: AgentProcessEngine::new(AgentCommandPlanner::from_env()),
            codex_runtime_proxy_config: Arc::new(AsyncMutex::new(
                CodexRuntimeProxyConfig::default(),
            )),
            event_tx: None,
            next_execution_id: Arc::new(AtomicU64::new(1)),
            task_send_gates: Arc::new(Mutex::new(HashMap::new())),
            turn_scheduler: Arc::new(Mutex::new(RuntimeTurnScheduler::new(
                runtime_settings.max_concurrent_tasks,
                queued_turns,
            ))),
            turn_queue_operation: Arc::new(AsyncMutex::new(())),
            turn_queue_path: Arc::new(turn_queue_path),
            interrupted_worktree_turns: Arc::new(AsyncMutex::new(Some(interrupted_worktree_turns))),
            preparing_worktree_turns: Arc::new(Mutex::new(HashMap::new())),
            active_turn_cancellations: Arc::new(Mutex::new(HashMap::new())),
            active_codex_turns: Arc::new(Mutex::new(HashMap::new())),
            active_codex_transcript_items: Arc::new(Mutex::new(HashMap::new())),
            active_request_user_inputs: Arc::new(Mutex::new(HashMap::new())),
            supervisor_evaluating: Arc::new(Mutex::new(HashSet::new())),
            supervisor_model_configs: Arc::new(Mutex::new(HashMap::new())),
            thread_event_routes: Arc::new(Mutex::new(HashMap::new())),
            notification_router: Arc::new(Mutex::new(None)),
            archived_delete_tx,
            automation_store: AutomationStore::from_env(),
            store,
            worktrees,
            worktree_reconciliation_state: Arc::new(AsyncMutex::new(
                WorktreeReconciliationState::default(),
            )),
            worktree_cleanup_generation: Arc::new(AtomicU64::new(0)),
            opened_workspace_roots: Arc::new(Mutex::new(HashSet::new())),
            hook_service: HookService::from_env(),
            backend_connection: Arc::new(Mutex::new(None)),
        };
        handler.spawn_archived_delete_worker(archived_delete_rx);
        handler
    }

    pub fn with_event_sender(
        device_id: impl Into<String>,
        codex_binary: impl Into<String>,
        event_tx: broadcast::Sender<Value>,
    ) -> Self {
        let handler = Self {
            event_tx: Some(event_tx),
            ..Self::new(device_id, codex_binary)
        };
        if let Some(sender) = handler.event_tx.clone() {
            handler.hook_service.set_event_sender(sender);
        }
        handler.spawn_startup_worktree_reconciliation();
        handler.start_automation_scheduler();
        handler
    }

    pub fn with_backend_connection(
        mut self,
        backend_connection: Arc<Mutex<Option<ConnectionConfig>>>,
    ) -> Self {
        self.backend_connection = backend_connection;
        self.start_supervisor_scheduler();
        self
    }

    /// Fill the request's backend connection fields from the executor's
    /// current configuration when the run payload did not provide them.
    /// Runtime tasks created through the App IPC (queue dispatches, project
    /// chat runs) do not carry credentials; `wework_space` relies on them to
    /// read cloud project data. This mirrors `normalize_local_task_request`
    /// used by the `task:execute` channel so both paths behave identically
    /// regardless of when the executor process was spawned.
    fn apply_backend_connection(&self, request: &mut ExecutionRequest) {
        let Ok(guard) = self.backend_connection.lock() else {
            return;
        };
        let Some(connection) = guard.as_ref() else {
            return;
        };
        if connection.backend_url.trim().is_empty() || connection.auth_token.trim().is_empty() {
            return;
        }
        if request
            .backend_url
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            request.backend_url = Some(connection.backend_url.clone());
        }
        if request
            .auth_token
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            request.auth_token = Some(connection.auth_token.clone());
        }
        if request
            .runtime_auth_token
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
            && !connection.runtime_auth_token.trim().is_empty()
        {
            request.runtime_auth_token = Some(connection.runtime_auth_token.clone());
        }
    }

    async fn dispatch(&self, method: &str, payload: Value) -> Result<Value, AppIpcError> {
        if !matches!(
            method,
            "runtime.worktrees.capabilities" | "runtime.worktrees.preflight"
        ) && self.reconcile_worktrees_once().await
        {
            self.resume_persisted_turns().await;
        }
        match method {
            "runtime.tasks.list" => self.list_tasks().await,
            "runtime.tasks.search" => self.search_tasks(payload).await,
            "runtime.tasks.transcript" => self.transcript(payload).await,
            "runtime.tasks.create" => self.create_task(payload).await,
            "runtime.tasks.fork_at_turn" => self.fork_task_at_turn(payload).await,
            "runtime.tasks.send" => self.send_message(payload).await,
            "runtime.tasks.interrupt_and_send" => self.interrupt_and_send(payload).await,
            "runtime.tasks.rollback" => self.rollback_task(payload).await,
            "runtime.tasks.guidance" => self.send_guidance(payload).await,
            "runtime.tasks.compact" => self.compact_task(payload).await,
            "runtime.tasks.prepare_fork_transfer" => self.prepare_fork_transfer(payload).await,
            "runtime.tasks.import_fork" => self.import_fork(payload).await,
            "runtime.tasks.archive" => self.archive_task(payload).await,
            "runtime.tasks.rename" => self.rename_task(payload).await,
            "runtime.tasks.cancel" => self.cancel_task(payload).await,
            "runtime.tasks.force_start" => self.force_start_task(payload).await,
            "runtime.tasks.queue.reorder" => self.reorder_queued_task(payload).await,
            "runtime.automations.list" => self.list_automations().await,
            "runtime.automations.get" => self.get_automation(payload).await,
            "runtime.automations.create" => self.create_automation(payload).await,
            "runtime.automations.update" => self.update_automation(payload).await,
            "runtime.automations.delete" => self.delete_automation(payload).await,
            "runtime.automations.toggle" => self.toggle_automation(payload).await,
            "runtime.automations.run_now" => self.run_automation_now(payload).await,
            "runtime.automation_runs.list" => self.list_automation_runs(payload).await,
            "runtime.tasks.goal.get" => self.get_task_goal(payload).await,
            "runtime.tasks.goal.set" => self.set_task_goal(payload).await,
            "runtime.tasks.goal.clear" => self.clear_task_goal(payload).await,
            "runtime.tasks.supervisor.get" => self.get_task_supervisor(payload).await,
            "runtime.tasks.supervisor.set" => self.set_task_supervisor(payload).await,
            "runtime.tasks.supervisor.clear" => self.clear_task_supervisor(payload).await,
            "runtime.tasks.supervisor.run_now" => self.run_task_supervisor_now(payload).await,
            "runtime.tasks.supervisor.resolve" => self.resolve_task_supervisor(payload).await,
            "runtime.keybindings.get" => self.get_keybindings().await,
            "runtime.keybindings.update" => self.update_keybindings(payload).await,
            "runtime.settings.get" => self.get_runtime_settings().await,
            "runtime.settings.update" => self.update_runtime_settings(payload).await,
            "runtime.capacity.get" => self.get_runtime_capacity().await,
            "runtime.hooks.list" | "runtime.hooks.reload" => {
                Ok(json!({"plugins": self.hook_service.list()}))
            }
            "runtime.hooks.create" => self.create_hook(payload).await,
            "runtime.hooks.install" => self.install_hook(payload).await,
            "runtime.hooks.update" => self.update_hook(payload).await,
            "runtime.hooks.set_enabled" => self.set_hook_enabled(payload).await,
            "runtime.hooks.delete" => self.delete_hook(payload).await,
            "runtime.hooks.reveal" => self.reveal_hook(payload).await,
            "runtime.hooks.test" => self.test_hook(payload).await,
            "runtime.codex.models.list" => self.list_codex_models(payload).await,
            "runtime.codex.ensure_started" => self.ensure_codex_started().await,
            "runtime.codex.catalog.custom.write" => self.write_custom_codex_catalog(payload).await,
            "runtime.codex.instructions.read" => self.read_codex_instructions().await,
            "runtime.codex.instructions.write" => self.write_codex_instructions(payload).await,
            "runtime.codex.personality.read" => self.read_codex_personality().await,
            "runtime.codex.personality.write" => self.write_codex_personality(payload).await,
            "runtime.codex.rate_limits.read" => self.read_codex_rate_limits().await,
            "runtime.codex.runtime_config.update" => {
                self.update_codex_runtime_config(payload).await
            }
            "runtime.codex.app_server.restart" => self.restart_codex_app_server(payload).await,
            "runtime.codex.stream_debug.get" => self.get_codex_stream_debug().await,
            "runtime.codex.stream_debug.set" => self.set_codex_stream_debug(payload).await,
            "runtime.harness_proxy.register" => self.register_harness_proxy(payload).await,
            "runtime.harness_proxy.unregister" => self.unregister_harness_proxy(payload).await,
            "runtime.harness_context.register" => self.register_harness_context(payload).await,
            "runtime.harness_context.unregister" => self.unregister_harness_context(payload).await,
            "runtime.connectors.configure" => self.connectors.configure(payload).await,
            "runtime.connectors.clear" => self.connectors.clear(payload).await,
            "runtime.connectors.status" => self.connectors.status().await,
            "runtime.connectors.tools" => self.connectors.tools().await,
            "runtime.connectors.call" => self.connectors.call(payload).await,
            "runtime.connectors.apps.sync" => self.connectors.sync_apps(payload).await,
            "runtime.local_connector_auth.health" => {
                super::local_connector_auth::health(payload).await
            }
            "runtime.local_connector_auth.start" => {
                super::local_connector_auth::start(payload).await
            }
            "runtime.local_connector_auth.poll" => super::local_connector_auth::poll(payload).await,
            "runtime.local_connector_auth.cancel" => {
                super::local_connector_auth::cancel(payload).await
            }
            "runtime.local_connector_auth.logout" => {
                super::local_connector_auth::logout(payload).await
            }
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
            "runtime.worktrees.capabilities" => self.get_worktree_capabilities().await,
            "runtime.worktrees.preflight" => self.preflight_worktree(payload).await,
            "runtime.worktrees.settings.get" => self.get_worktree_settings().await,
            "runtime.worktrees.settings.update" => self.update_worktree_settings(payload).await,
            "runtime.worktrees.prepare" => self.prepare_worktree(payload).await,
            "runtime.worktrees.list" => self.list_worktrees().await,
            "runtime.worktrees.delete" => self.delete_worktree(payload).await,
            "runtime.worktrees.restore" => self.restore_worktree(payload).await,
            "runtime.worktrees.prune" => self.prune_worktrees().await,
            "runtime.workspaces.open" => self.open_workspace(payload).await,
            "runtime.projects.upsert_local" => self.upsert_local_project(payload).await,
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
}

include!("handler/helpers.rs");

mod runtime_rpc;

use runtime_rpc::{
    log_runtime_collect_diagnostic, log_runtime_work_list_diagnostic,
    log_slow_runtime_collect_thread, log_slow_runtime_collect_thread_missing,
};

#[cfg(test)]
use runtime_rpc::is_allowed_plugin_app_server_method;

#[cfg(test)]
#[path = "handler/tests.rs"]
mod tests;
