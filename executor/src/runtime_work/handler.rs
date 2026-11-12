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
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
    time::{Duration, Instant},
};

use chrono::Local;
use futures_util::{stream, StreamExt};
use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex as AsyncMutex, Semaphore};
use tokio::time::sleep;

use crate::{
    agents::{
        codex_notification_requires_user_input, codex_runtime_approval_policy,
        select_wework_codex_user_instructions, AgentCommandPlanner, AgentProcessEngine,
        CodexActiveTurnCallback, CodexActiveTurnFinishedCallback, CodexAppServerClient,
        CodexAppServerTurnOptions, CodexIdleMutationError, CodexNotification,
        CodexRequestUserInputReceiver, CodexThreadStartedCallback, CODEX_APP_SERVER_TURN_CANCELLED,
        CODEX_DANGER_FULL_ACCESS_PERMISSION_PROFILE, CODEX_READ_ONLY_PERMISSION_PROFILE,
        CODEX_WORKSPACE_PERMISSION_PROFILE,
    },
    attachments::device_runtime_attachment_task_dir,
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
    server::{
        executor_loopback_base_url, harness_context, local_decision_proxy, local_model_proxy,
    },
    task_runtime::LocalTaskStore,
};

const WORKTREE_RECONCILIATION_RETRY_INTERVAL: Duration = Duration::from_secs(5);
const DEFAULT_RESTORE_STARTUP_CONCURRENCY: usize = 2;
const RESTORE_STARTUP_CONCURRENCY_ENV: &str = "WEGENT_RUNTIME_RESTORE_CONCURRENCY";
const RESTORED_TURN_MARKER: &str = "wegent_restore_after_restart";
const RESUME_GOAL_ONLY_MARKER: &str = "wegent_resume_goal_only";
const GOAL_NEEDS_ATTENTION_MARKER: &str = "wegent_goal_needs_attention";
const RESTORE_STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
const INTERACTION_WAITING_FOR_USER_INPUT: &str = "waitingForUserInput";
const INTERACTION_AWAITING_USER_REPLY: &str = "awaitingUserReply";
const COLLABORATION_MANAGER_CONTEXT_KEY: &str = "collaborationManagerContext";

enum RestoreStartupState {
    Waiting {
        _permit: tokio::sync::OwnedSemaphorePermit,
    },
    Active,
    TimedOut,
    Finished,
}

struct RestoreStartupGate {
    state: Mutex<RestoreStartupState>,
}

impl RestoreStartupGate {
    fn new(permit: tokio::sync::OwnedSemaphorePermit) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(RestoreStartupState::Waiting { _permit: permit }),
        })
    }

    fn try_activate(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .expect("restore startup state lock should not be poisoned");
        if matches!(*state, RestoreStartupState::Active) {
            return true;
        }
        if !matches!(*state, RestoreStartupState::Waiting { .. }) {
            return false;
        }
        *state = RestoreStartupState::Active;
        true
    }

    fn try_timeout(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .expect("restore startup state lock should not be poisoned");
        if !matches!(*state, RestoreStartupState::Waiting { .. }) {
            return false;
        }
        *state = RestoreStartupState::TimedOut;
        true
    }

    fn finish(&self) {
        let mut state = self
            .state
            .lock()
            .expect("restore startup state lock should not be poisoned");
        if matches!(
            *state,
            RestoreStartupState::Waiting { .. } | RestoreStartupState::Active
        ) {
            *state = RestoreStartupState::Finished;
        }
    }
}

mod active_text;
mod active_transcript;
mod archives;
mod assignment_receipts;
mod async_questions;
mod automatic_turns;
mod automation_rpc;
mod background_terminals;
mod bounded_history;
mod claude_turns;
mod codex_accounts;
mod codex_config;
mod collection;
mod command_items;
mod command_journal;
mod concurrency;
mod connections;
mod context_compaction;
mod control;
mod control_metadata;
mod conversation_provider;
mod conversation_sessions;
mod creation;
mod execution_control;
mod fork_transfer;
mod git_connections;
mod git_source_workspace;
mod git_webhook_setup;
mod hooks;
pub(super) mod lifecycle;
mod mcp_approval_context;
mod mcp_apps;
mod notifications;
mod personal_stand_in;
mod plugin_install;
mod plugin_marketplace;
mod project_coordination_binding;
mod project_coordination_commands;
mod project_coordination_execution;
mod project_coordinator;
mod project_preparation;
mod project_router;
mod queries;
mod queries_projection;
mod robot_queue_rpc;
mod runner_catalog;
mod runner_cloud_models;
mod runtime_owner;
mod side_source;
mod sidebar;
mod stand_in;
mod stand_in_agent;
mod stand_in_arrangements;
mod stand_in_assignment_intake;
mod stand_in_calendar;
mod stand_in_connection_guidance;
mod stand_in_conversations;
mod stand_in_diagnostics;
mod stand_in_dispatches;
mod stand_in_events;
mod stand_in_execution;
mod stand_in_history;
mod stand_in_ingress;
mod stand_in_issue_mentions;
mod stand_in_issue_replies;
mod stand_in_lifecycle;
mod stand_in_memory;
mod stand_in_memory_progress;
mod stand_in_memory_review;
mod stand_in_processing;
mod stand_in_proposal_continuations;
mod stand_in_read_sources;
mod stand_in_review;
mod stand_in_schedules;
mod stand_in_task_results;
mod stand_in_tasks;
mod stand_in_telemetry;
mod stand_in_work;
mod stand_in_workspace;
mod submitted_model;
mod supervisor;
use concurrency::{RuntimeSettings, RuntimeTaskKind, RuntimeTurnScheduler};

mod system;
mod tasks;
mod text_generation;
mod transcript_diagnostics;
mod transcript_overlays;
mod transcript_read_link;
mod transcript_search;
mod transcript_sync;
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
        load_codex_transcript, load_codex_transcript_navigation, read_codex_thread_metadata,
        CodexTranscriptDirection, CodexTranscriptNavigation, CodexTranscriptPage,
        CodexTranscriptRequest,
    },
    connectors::ConnectorRuntime,
    events::{
        emit_response_event, emit_runtime_work_changed, is_context_compaction_request,
        next_runtime_event_sequence, CodexNotificationEventMapper,
    },
    notification_mapping::{codex_stream_debug_enabled, set_codex_stream_debug_enabled},
    response::{
        archived_conversations_response, codex_thread_has_in_progress_turn,
        codex_thread_in_progress_turn_id, codex_thread_terminal_task_status,
        runtime_status_is_running, search_result_item, workspace_response, RuntimeTaskLink,
        RuntimeWorkspaceLink, SearchResultMatch,
    },
    runtime_handle_messages::{
        append_completed_transcript_messages, append_runtime_handle_message,
        append_runtime_handle_user_message_presentation, append_unique_transcript_messages,
        bind_runtime_handle_user_message_presentation_to_turn, cached_messages,
        clear_completed_transcript_messages, clear_runtime_handle_messages,
        clear_transcript_snapshot_messages, completed_transcript_messages,
        merge_assistant_transcript_message, set_runtime_handle_messages,
        set_transcript_snapshot_messages, transcript_snapshot_messages,
        transcript_snapshot_pagination, user_message_presentations, visit_transcript_blocks_mut,
    },
    store::{runtime_work_dir, RuntimeWorkStore},
    transcript::{normalized_user_request_content, notification_item, transcript_messages},
    transcript_page::transcript_page,
    util::{
        apply_runtime_payload_metadata, bool_field, cloud_project_id, execution_request, id_field,
        infer_workspace_kind, integer_field, is_codex_context_compaction_item_type,
        is_codex_runtime, item_id, item_type, model_provider_routing, normalize_device_id,
        normalize_runtime_goal_timestamps, normalize_workspace_path, now_ms, prompt_text,
        raw_string_field, replace_runtime_task_id, restore_cloud_project_id, restore_origin,
        runtime_task_id, runtime_task_title, set_runtime_task_title, string_field,
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
const CODEX_TRANSCRIPT_NAVIGATION_CACHE_TTL: Duration = Duration::from_secs(30);
const CODEX_TRANSCRIPT_NAVIGATION_CACHE_MAX_ENTRIES: usize = 64;
const PROVIDER_STATE_RECONCILIATION_TIMEOUT: Duration = Duration::from_millis(500);
const PROVIDER_TURN_INTERRUPT_WAIT_ATTEMPTS: usize = 100;
/// How long the App-IPC caller waits for a compaction response. The owned native
/// action retains its activity and model route until completion beyond this.
pub(crate) const CONTEXT_COMPACTION_ACTION_BUDGET_SECONDS: u64 = 180;
const PROVIDER_TURN_INTERRUPT_WAIT_MS: u64 = 100;
const TRANSCRIPT_NAVIGATION_PREVIEW_CHARS: usize = 96;
const SEARCH_SNIPPET_CONTEXT_CHARS: usize = 80;
const SEARCH_SNIPPET_MAX_CHARS: usize = 240;
const ARCHIVED_BACKGROUND_THREAD_DELETE_SLOW_THRESHOLD: Duration = Duration::from_secs(5);
const ARCHIVED_BACKGROUND_DELETE_INTERVAL: Duration = Duration::from_millis(250);
const ARCHIVED_BACKGROUND_FORK_RETRY_LIMIT: usize = 3;
const ARCHIVED_BACKGROUND_FORK_RETRY_DELAY: Duration = Duration::from_secs(1);
const WORKTREE_AUTO_CLEANUP_IDLE_DELAY: Duration = Duration::from_secs(5 * 60);
const WORKTREE_AUTO_CLEANUP_BATCH_DELAY: Duration = Duration::from_secs(30);
const WORKTREE_AUTO_CLEANUP_ERROR_DELAY: Duration = Duration::from_secs(5 * 60);
const WORKTREE_AUTO_CLEANUP_MAX_EMPTY_ROUNDS: usize = 3;
const CODEX_OFFICIAL_PROVIDER_ID: &str = "openai";
const CODEX_OFFICIAL_PROVIDER_NAME: &str = "CodeX";
const DEFAULT_MAX_CONCURRENT_TASKS: usize = 10;
const MIN_MAX_CONCURRENT_TASKS: usize = 1;
const MAX_MAX_CONCURRENT_TASKS: usize = 20;
const MAX_PENDING_CODEX_NOTIFICATIONS: usize = 256;

fn restore_startup_concurrency(max_concurrent_tasks: usize) -> usize {
    let configured = env::var(RESTORE_STARTUP_CONCURRENCY_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok());
    normalized_restore_startup_concurrency(configured, max_concurrent_tasks)
}

fn normalized_restore_startup_concurrency(
    configured: Option<usize>,
    max_concurrent_tasks: usize,
) -> usize {
    configured
        .unwrap_or(DEFAULT_RESTORE_STARTUP_CONCURRENCY)
        .clamp(1, max_concurrent_tasks.max(1))
}

fn worktree_error_code(error: &str) -> &'static str {
    [
        "worktree_source_missing",
        "worktree_source_not_git",
        "worktree_source_changed",
        "worktree_root_unwritable",
        "worktree_git_common_dir_unwritable",
        "worktree_ref_not_found",
        "worktree_target_conflict",
        "worktree_persistent_storage_unverified",
    ]
    .into_iter()
    .find(|code| error.starts_with(&format!("{code}:")))
    .unwrap_or("worktree_prepare_failed")
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SpawnTurnRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    task_kind: Option<RuntimeTaskKind>,
    local_task_id: String,
    #[serde(default = "default_turn_runtime")]
    runtime: String,
    request: ExecutionRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    send_payload: Option<Value>,
    direct_thread_id: Option<String>,
    fork_thread_id: Option<String>,
    fork_thread_path: Option<String>,
    resume_thread_id: Option<String>,
    initial_thread_goal: Option<Value>,
}

fn default_turn_runtime() -> String {
    "codex".to_owned()
}

fn standalone_chat_workspace_path(
    local_task_id: &str,
    request: &ExecutionRequest,
) -> Option<String> {
    if !is_standalone_chat_workspace(request) {
        return None;
    }
    let segment = workspace_segment(local_task_id);
    let path = standalone_workspace_root()
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

fn standalone_workspace_root() -> PathBuf {
    env::var_os("WEGENT_STANDALONE_WORKSPACE_ROOT")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join("Documents").join("Codex"))
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
    let configured_provider = crate::agents::configured_inference_model_provider();
    current_codex_model_provider(config_response, &configured_provider)
}

fn current_codex_model_provider(
    config_response: &Value,
    configured_provider: &str,
) -> CodexModelProviderInfo {
    let config = config_response
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let runtime_provider = string_from_map(&config, "modelProvider")
        .or_else(|| string_from_map(&config, "model_provider"))
        .filter(|provider| {
            provider != crate::server::codex_model_catalog::PROVIDER_ID
                && provider != crate::server::codex_model_catalog::LEGACY_PROVIDER_ID
                && provider != "wework-catalog"
        });
    let current_provider = if configured_provider != CODEX_OFFICIAL_PROVIDER_ID {
        configured_provider.to_owned()
    } else {
        runtime_provider.unwrap_or_else(|| configured_provider.to_owned())
    };
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
    #[cfg(test)]
    transcript_test_workers: Option<Arc<tokio::sync::Semaphore>>,
    device_id: String,
    codex_app_server: CodexAppServerClient,
    claude_process_engine: AgentProcessEngine,
    codex_runtime_proxy_config: Arc<AsyncMutex<CodexRuntimeProxyConfig>>,
    startup_recovery_deferred: Arc<AtomicBool>,
    bundled_plugin_marketplace_reconciliation: Arc<AsyncMutex<()>>,
    event_tx: Option<broadcast::Sender<Value>>,
    next_execution_id: Arc<AtomicU64>,
    task_send_gates: Arc<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>>,
    stand_in_lifecycle_gate: Arc<Mutex<()>>,
    turn_scheduler: Arc<Mutex<RuntimeTurnScheduler>>,
    active_goal_turns: Arc<Mutex<HashMap<String, SpawnTurnRequest>>>,
    restore_startup_semaphore: Arc<Semaphore>,
    command_journal: Arc<Mutex<command_journal::CommandJournal>>,
    turn_queue_operation: Arc<AsyncMutex<()>>,
    turn_queue_path: Arc<PathBuf>,
    preparing_worktree_turns: Arc<Mutex<HashMap<String, PreparingWorktreeTurn>>>,
    active_local_executions: Arc<Mutex<HashMap<String, ActiveLocalExecution>>>,
    active_text_generations: Arc<Mutex<HashMap<String, Option<oneshot::Sender<()>>>>>,
    active_codex_transcript_items: Arc<Mutex<HashMap<String, ActiveCodexTranscriptItems>>>,
    codex_transcript_navigation_cache: Arc<Mutex<HashMap<String, CachedCodexTranscriptNavigation>>>,
    active_request_user_inputs: Arc<Mutex<HashMap<String, ActiveRequestUserInput>>>,
    supervisor_evaluating: Arc<Mutex<HashSet<String>>>,
    supervisor_model_configs: Arc<Mutex<HashMap<String, Value>>>,
    runtime_model_configs: Arc<Mutex<HashMap<String, Value>>>,
    creation_model_profiles: Arc<Mutex<Vec<Value>>>,
    submitted_model_bindings:
        Arc<Mutex<HashMap<String, submitted_model::SubmittedInterfaceBinding>>>,
    local_runner_models: Arc<Mutex<Vec<Value>>>,
    active_collaboration_rounds: Arc<Mutex<HashSet<String>>>,
    thread_event_routing: Arc<Mutex<RuntimeThreadEventRouting>>,
    codex_notification_delivery: Arc<Mutex<()>>,
    notification_router: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    local_issue_scheduler_started: Arc<AtomicBool>,
    archived_delete_tx: mpsc::UnboundedSender<RuntimeTaskLink>,
    automation_store: AutomationStore,
    task_store_path: Arc<PathBuf>,
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
    backend_device_route: Option<Arc<Mutex<Option<String>>>>,
}

struct CodexRuntimeProxyConfig {
    initialized: bool,
    proxy_url: Option<String>,
}

impl Default for CodexRuntimeProxyConfig {
    fn default() -> Self {
        Self {
            initialized: true,
            proxy_url: None,
        }
    }
}

#[derive(Default)]
struct WorktreeReconciliationState {
    completed: bool,
    last_attempt: Option<Instant>,
}

struct ActiveLocalExecution {
    execution_id: u64,
    request: Option<ExecutionRequest>,
    stop_requested: bool,
    stop_acknowledged: bool,
    cancel: oneshot::Sender<()>,
    stopped: oneshot::Receiver<()>,
    codex_turn: Option<ActiveCodexTurn>,
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
    thread_id: String,
    turn_id: String,
    items: Vec<Value>,
    // Keep settled request IDs until the turn ends so replay cannot reopen them.
    user_input_requests: HashMap<String, bool>,
}

#[derive(Clone)]
struct CachedCodexTranscriptNavigation {
    cached_at: Instant,
    navigation: CodexTranscriptNavigation,
}

struct RuntimeThreadEventRoute {
    local_task_id: String,
    request: ExecutionRequest,
    event_mapper: Arc<Mutex<CodexNotificationEventMapper>>,
    active: bool,
    nested: bool,
    generation: u64,
}

#[derive(Default)]
struct RuntimeThreadEventRouting {
    routes: HashMap<String, RuntimeThreadEventRoute>,
    pending_notifications: VecDeque<PendingCodexNotification>,
    replaying_route_generations: HashMap<String, u64>,
    next_route_generation: u64,
}

struct PendingCodexNotification {
    thread_id: String,
    message: CodexNotification,
}

struct PendingCodexNotificationReplay {
    route_generations: HashMap<String, u64>,
    notifications: Vec<PendingCodexNotification>,
}

struct ScheduledTurnGuard {
    handler: RuntimeWorkRpcHandler,
    local_task_id: String,
    execution_id: u64,
    command_id: Option<String>,
    command_outcome: Option<command_journal::CommandState>,
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
    fn new(
        handler: RuntimeWorkRpcHandler,
        local_task_id: String,
        execution_id: u64,
        command_id: Option<String>,
    ) -> Self {
        Self {
            handler,
            local_task_id,
            execution_id,
            command_id,
            command_outcome: None,
        }
    }
}

impl Drop for ScheduledTurnGuard {
    fn drop(&mut self) {
        let handler = self.handler.clone();
        let local_task_id = self.local_task_id.clone();
        let execution_id = self.execution_id;
        let command_id = self.command_id.clone();
        let command_outcome = self.command_outcome.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                handler
                    .finish_command_execution(
                        &local_task_id,
                        execution_id,
                        command_id.as_deref(),
                        command_outcome,
                    )
                    .await;
            });
        }
    }
}

struct SideSourceThread {
    thread_id: String,
    thread_path: Option<String>,
    workspace_path: String,
}

impl RuntimeThreadEventRoute {
    fn new(
        local_task_id: String,
        request: ExecutionRequest,
        active: bool,
        generation: u64,
    ) -> Self {
        Self {
            local_task_id,
            request,
            event_mapper: Arc::new(Mutex::new(CodexNotificationEventMapper::default())),
            active,
            nested: false,
            generation,
        }
    }
}

mod backend_connection;
mod initialization;

impl RuntimeWorkRpcHandler {
    async fn dispatch(&self, method: &str, payload: Value) -> Result<Value, AppIpcError> {
        let configure_before_startup_recovery = method == "runtime.codex.runtime_config.update";
        let startup_recovery_deferred = self.startup_recovery_deferred.load(Ordering::Acquire);
        if !startup_recovery_deferred
            && !configure_before_startup_recovery
            && should_resume_persisted_turns_before_rpc(method)
        {
            self.reconcile_and_resume_persisted_turns().await;
        }
        let stand_in_operation = self.stand_in_operation(method, &payload);
        let result = self.dispatch_method(method, payload).await;
        if let Some((user, operation, properties)) = stand_in_operation {
            // Successful configuration diffs are recorded in the settings transaction.
            if operation != "configuration" || result.is_err() {
                let rejected = result
                    .as_ref()
                    .ok()
                    .filter(|value| value["success"] == false || value["accepted"] == false)
                    .map(|_| {
                        AppIpcError::new("stand_in_start_failed", "Operation was not accepted")
                    });
                self.record_stand_in_result(
                    user,
                    operation,
                    properties,
                    result.as_ref().err().or(rejected.as_ref()),
                );
            }
        }
        if configure_before_startup_recovery && result.is_ok() {
            self.startup_recovery_deferred
                .store(false, Ordering::Release);
            self.reconcile_and_resume_persisted_turns().await;
        }
        result
    }
}

fn should_resume_persisted_turns_before_rpc(method: &str) -> bool {
    // Connection discovery and transport must never resume unrelated model work.
    if method.starts_with("runtime.connections.")
        || method.starts_with("runtime.stand_in.telemetry.")
        || method.starts_with("runtime.stand_in.onboarding.")
        || method == "runtime.stand_in.processing.status"
        || method == "runtime.stand_in.binding"
        || method == "runtime.stand_in.personal.lifecycle"
    {
        return false;
    }
    !matches!(
        method,
        "runtime.tasks.running_count"
            | "runtime.python.has_demand"
            | "runtime.stand_in.assignment_tasks"
            | "runtime.tasks.get"
            | "runtime.composer.catalog.read"
            | "runtime.worktrees.capabilities"
            | "runtime.worktrees.preflight"
            | "runtime.codex.runtime_config.update"
    )
}

fn codex_app_server_restart_gate() -> &'static AsyncMutex<()> {
    static GATE: OnceLock<AsyncMutex<()>> = OnceLock::new();
    GATE.get_or_init(|| AsyncMutex::new(()))
}

include!("handler/helpers.rs");

mod collaboration;
mod composer_catalog;
mod dispatch;
mod plugin_catalog;
mod runtime_rpc;

use runtime_rpc::{
    log_runtime_collect_diagnostic, log_runtime_work_list_diagnostic,
    log_slow_runtime_collect_thread, log_slow_runtime_collect_thread_missing,
};

#[cfg(test)]
use runtime_rpc::is_allowed_plugin_app_server_method;

#[cfg(test)]
#[path = "handler/tests.rs"]
pub(super) mod tests;
