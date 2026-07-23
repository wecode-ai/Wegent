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
    hooks::{
        codex::{post_tool_use_from_notification, CodexHookContext},
        host::HookService,
    },
    local::app_ipc::{AppIpcError, RuntimeWorkHandler},
    logging::log_executor_event,
    protocol::ExecutionRequest,
    runner::ExecutionOutcome,
};

mod archives;
mod codex_config;
mod collection;
mod fork_transfer;
mod hooks;
mod notifications;
mod queries;
mod sidebar;
mod system;
mod tasks;
mod turns;
mod workspaces;

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
    connectors::ConnectorRuntime,
    events::{emit_response_event, CodexNotificationEventMapper},
    notification_mapping::{codex_stream_debug_enabled, set_codex_stream_debug_enabled},
    response::{
        archived_conversations_response, runtime_status_is_running, search_result_item,
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
        prompt_text, runtime_task_id, string_field, timestamp_ms_field, workspace_group_path,
        workspace_path,
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
    hook_service: HookService,
    connectors: ConnectorRuntime,
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
        let codex_app_server = CodexAppServerClient::new(codex_binary);
        let handler = Self {
            device_id: normalize_device_id(device_id.into()),
            connectors: ConnectorRuntime::new(codex_app_server.clone()),
            codex_app_server,
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
            hook_service: HookService::from_env(),
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
        handler
    }

    async fn dispatch(&self, method: &str, payload: Value) -> Result<Value, AppIpcError> {
        match method {
            "runtime.tasks.list" => self.list_tasks().await,
            "runtime.tasks.search" => self.search_tasks(payload).await,
            "runtime.tasks.transcript" => self.transcript(payload).await,
            "runtime.tasks.create" => self.create_task(payload).await,
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
            "runtime.tasks.goal.get" => self.get_task_goal(payload).await,
            "runtime.tasks.goal.set" => self.set_task_goal(payload).await,
            "runtime.tasks.goal.clear" => self.clear_task_goal(payload).await,
            "runtime.keybindings.get" => self.get_keybindings().await,
            "runtime.keybindings.update" => self.update_keybindings(payload).await,
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
            "runtime.codex.catalog.custom.write" => self.write_custom_codex_catalog(payload).await,
            "runtime.codex.instructions.read" => self.read_codex_instructions().await,
            "runtime.codex.instructions.write" => self.write_codex_instructions(payload).await,
            "runtime.codex.personality.read" => self.read_codex_personality().await,
            "runtime.codex.personality.write" => self.write_codex_personality(payload).await,
            "runtime.codex.rate_limits.read" => self.read_codex_rate_limits().await,
            "runtime.codex.app_server.restart" => self.restart_codex_app_server(payload).await,
            "runtime.codex.stream_debug.get" => self.get_codex_stream_debug().await,
            "runtime.codex.stream_debug.set" => self.set_codex_stream_debug(payload).await,
            "runtime.connectors.configure" => self.connectors.configure(payload).await,
            "runtime.connectors.clear" => self.connectors.clear(payload).await,
            "runtime.connectors.status" => self.connectors.status().await,
            "runtime.connectors.tools" => self.connectors.tools().await,
            "runtime.connectors.call" => self.connectors.call(payload).await,
            "runtime.connectors.apps.sync" => self.connectors.sync_apps(payload).await,
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
