// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{HashMap, HashSet},
    env, fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
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
        CodexActiveTurnCallback, CodexAppServerClient, CodexAppServerTurnOptions,
        CodexRequestUserInputReceiver, CodexThreadStartedCallback, CODEX_APP_SERVER_TURN_CANCELLED,
    },
    local::app_ipc::{AppIpcError, RuntimeWorkHandler},
    logging::log_executor_event,
    protocol::ExecutionRequest,
    runner::ExecutionOutcome,
};

use super::{
    archived_cleanup::{
        managed_worktree_container, managed_worktree_roots, orphaned_managed_worktree_links,
    },
    codex_global_state::{
        open_codex_global_project, register_codex_global_thread_workspace_root,
        remove_codex_global_project, rename_codex_global_project, CodexGlobalProjectIndex,
    },
    codex_notifications::codex_notification,
    codex_rollout::{
        append_rollout_turns_from_offset, rollout_context_usage, rollout_turns,
        thread_with_rollout_turns, thread_with_turns,
    },
    events::{emit_response_event, CodexNotificationEventMapper},
    notification_mapping::{codex_stream_debug_enabled, set_codex_stream_debug_enabled},
    response::{
        archived_conversations_response, search_result_item, workspace_response, RuntimeTaskLink,
        RuntimeWorkspaceLink, SearchResultMatch,
    },
    runtime_handle_messages::{
        append_runtime_handle_message, cached_messages, merge_cached_messages,
        retain_runtime_handle_user_messages, set_runtime_handle_messages,
        CodexNotificationCacheMapper,
    },
    store::{runtime_work_dir, RuntimeWorkStore},
    transcript::{full_transcript_messages, transcript_messages},
    transcript_cache::{CachedTranscript, TranscriptCache, TranscriptSourceSignature},
    transcript_page::transcript_page,
    util::{
        apply_runtime_payload_metadata, bool_field, execution_request, id_field,
        infer_workspace_kind, integer_field, normalize_device_id, normalize_workspace_path, now_ms,
        prompt_text, runtime_task_id, string_field, workspace_group_path, workspace_path,
    },
};

const CODEX_THREAD_LIST_PAGE_SIZE: usize = 100;
const CODEX_THREAD_LIST_MAX_ITEMS: usize = 500;
const CODEX_THREAD_LIST_CACHE_TTL_MS: i64 = 1_500;
const CODEX_THREAD_SOURCE_KINDS: &[&str] = &["cli", "vscode", "exec", "appServer"];
const PENDING_THREAD_EVENT_ROUTE_PREFIX: &str = "pending:";
const ACTIVE_CODEX_TURN_WAIT_ATTEMPTS: usize = 20;
const ACTIVE_CODEX_TURN_WAIT_MS: u64 = 50;
const TRANSCRIPT_NAVIGATION_PREVIEW_CHARS: usize = 96;
const SEARCH_SNIPPET_CONTEXT_CHARS: usize = 80;
const SEARCH_SNIPPET_MAX_CHARS: usize = 240;
const ARCHIVED_BACKGROUND_THREAD_DELETE_SLOW_THRESHOLD: Duration = Duration::from_secs(5);
const ARCHIVED_BACKGROUND_DELETE_INTERVAL: Duration = Duration::from_millis(250);
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
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir)
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
    transcript_cache: TranscriptCache,
    thread_list_cache: CodexThreadListCache,
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
    cache_mapper: CodexNotificationCacheMapper,
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
            cache_mapper: CodexNotificationCacheMapper::default(),
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
            transcript_cache: TranscriptCache::default(),
            thread_list_cache: CodexThreadListCache::default(),
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
            "runtime.workspaces.open" => self.open_workspace(payload).await,
            "runtime.workspaces.rename" => self.rename_workspace(payload).await,
            "runtime.workspaces.remove" => self.remove_workspace(payload).await,
            unsupported => Err(AppIpcError::new(
                "unsupported_method",
                format!("Unsupported runtime RPC method: {unsupported}"),
            )),
        }
    }
}

#[path = "archived_tasks.rs"]
mod archived_tasks;
#[path = "codex_settings.rs"]
mod codex_settings;
#[path = "handler_helpers.rs"]
mod handler_helpers;
#[path = "runtime_state.rs"]
mod runtime_state;
#[path = "task_actions.rs"]
mod task_actions;
#[path = "task_queries.rs"]
mod task_queries;
#[path = "thread_links.rs"]
mod thread_links;
#[path = "turn_runtime.rs"]
mod turn_runtime;

use handler_helpers::*;

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
#[path = "handler_tests.rs"]
mod handler_tests;
