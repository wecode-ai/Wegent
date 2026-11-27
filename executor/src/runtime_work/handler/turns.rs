// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::agents::{CODEX_APP_SERVER_ACTIVE_GOAL_INTERRUPTED, CODEX_APP_SERVER_EXECUTOR_SHUTDOWN};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex as StdMutex, OnceLock,
};
use wegent_protocol::chat_errors::error_info;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const RUNTIME_TURN_QUEUE_VERSION: u64 = 1;
const RUNTIME_TURN_QUEUE_AAD: &[u8] = b"wework-runtime-turn-queue-v1";
const WORKTREE_PREPARATION_STOP_WAIT_ATTEMPTS: usize = 600;
const WORKTREE_PREPARATION_STOP_WAIT_MS: u64 = 50;
static RUNTIME_TURN_QUEUE_WRITE_LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
static RUNTIME_TURN_QUEUE_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn personal_runtime_scope(request: &ExecutionRequest, runtime_handle: &Value) -> bool {
    let is_empty_origin = |origin: &Value| {
        origin.is_null() || origin.as_object().is_some_and(|object| object.is_empty())
    };
    request.extra.get("origin").map_or(true, is_empty_origin)
        && cloud_project_id(request).is_none()
        && !request.extra.contains_key("standInDelegation")
        && !request.extra.contains_key("standInSchedule")
        && super::super::util::runtime_origin(runtime_handle).map_or(true, is_empty_origin)
        && ["cloudProjectId", "cloud_project_id", "wegentTeam"]
            .iter()
            .all(|key| runtime_handle[*key].is_null())
        && ["standInDelegation", "standInSchedule"]
            .iter()
            .all(|key| runtime_handle["executionRequest"][*key].is_null())
}

fn interrupted_by_runtime_stop(result: &Result<crate::agents::CodexAppServerTurn, String>) -> bool {
    matches!(result, Err(error) if error == CODEX_APP_SERVER_EXECUTOR_SHUTDOWN
        || error == CODEX_APP_SERVER_ACTIVE_GOAL_INTERRUPTED)
}

fn record_preparation_failure(
    link: &mut RuntimeTaskLink,
    request: &ExecutionRequest,
    error: &AppIpcError,
    failure_info: &Value,
    timestamp: i64,
) {
    let mut diagnostic = link.runtime_handle["startupFailure"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let message = crate::agents::redact_diagnostic_text(&error.message);
    diagnostic.insert("code".into(), json!(error.code));
    diagnostic.insert("message".into(), json!(message));
    diagnostic.insert("subtaskId".into(), json!(request.subtask_id));
    diagnostic.insert("createdAt".into(), json!(timestamp));
    diagnostic.insert("failedAt".into(), json!(timestamp));
    diagnostic.insert("errorInfo".into(), failure_info.clone());
    link.runtime_handle["startupFailure"] = Value::Object(diagnostic);
    link.runtime_handle["lastError"] = json!(message);
    link.runtime_handle["lastErrorCode"] = json!(error.code);
}

fn initial_turn_presentation(request: &ExecutionRequest) -> Option<(String, Option<String>)> {
    // A recovered Goal continues autonomously; it does not submit the persisted user message again.
    if request.extra.contains_key(quota_recovery::MARKER)
        || request
            .extra
            .get(RESUME_GOAL_ONLY_MARKER)
            .and_then(Value::as_bool)
            == Some(true)
    {
        return None;
    }
    let client_user_message_id = request
        .extra
        .get("client_user_message_id")
        .or_else(|| request.extra.get("clientUserMessageId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    Some((request.subtask_id.clone(), client_user_message_id))
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedRuntimeTurnQueue {
    version: u64,
    nonce: String,
    ciphertext: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeTurnQueuePayload {
    version: u64,
    turns: VecDeque<SpawnTurnRequest>,
    #[serde(default)]
    active_goal_turns: HashMap<String, SpawnTurnRequest>,
    #[serde(default)]
    commands: command_journal::CommandJournal,
}

#[derive(Default)]
pub(super) struct RuntimeTurnQueueState {
    pub(super) queued_turns: VecDeque<SpawnTurnRequest>,
    pub(super) active_goal_turns: HashMap<String, SpawnTurnRequest>,
    pub(super) commands: command_journal::CommandJournal,
}

pub(super) fn runtime_turn_queue_path() -> PathBuf {
    runtime_work_dir().join("turn-queue.json")
}

fn runtime_turn_queue_key_path(queue_path: &Path) -> PathBuf {
    queue_path.with_file_name("turn-queue.key")
}

#[cfg(test)]
pub(super) fn read_runtime_turn_queue(
    queue_path: &Path,
) -> Result<VecDeque<SpawnTurnRequest>, String> {
    read_runtime_turn_state(queue_path).map(|state| state.queued_turns)
}

pub(super) fn read_runtime_turn_state(queue_path: &Path) -> Result<RuntimeTurnQueueState, String> {
    let envelope_bytes = match fs::read(queue_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RuntimeTurnQueueState::default());
        }
        Err(error) => return Err(format!("Failed to read {}: {error}", queue_path.display())),
    };
    let envelope = serde_json::from_slice::<EncryptedRuntimeTurnQueue>(&envelope_bytes)
        .map_err(|error| format!("Failed to parse {}: {error}", queue_path.display()))?;
    if envelope.version != RUNTIME_TURN_QUEUE_VERSION {
        return Err(format!(
            "Unsupported runtime turn queue version {}",
            envelope.version
        ));
    }
    let key = read_runtime_turn_queue_key(queue_path)?;
    let nonce = BASE64
        .decode(envelope.nonce)
        .map_err(|error| format!("Failed to decode runtime turn queue nonce: {error}"))?;
    let ciphertext = BASE64
        .decode(envelope.ciphertext)
        .map_err(|error| format!("Failed to decode runtime turn queue payload: {error}"))?;
    let nonce: [u8; 12] = nonce
        .try_into()
        .map_err(|_| "Runtime turn queue nonce must be 12 bytes".to_owned())?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| format!("Failed to initialize runtime turn queue cipher: {error}"))?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            aes_gcm::aead::Payload {
                msg: &ciphertext,
                aad: RUNTIME_TURN_QUEUE_AAD,
            },
        )
        .map_err(|_| "Failed to decrypt runtime turn queue".to_owned())?;
    let payload = serde_json::from_slice::<RuntimeTurnQueuePayload>(&plaintext)
        .map_err(|error| format!("Failed to parse decrypted runtime turn queue: {error}"))?;
    if payload.version != RUNTIME_TURN_QUEUE_VERSION {
        return Err(format!(
            "Unsupported decrypted runtime turn queue version {}",
            payload.version
        ));
    }
    Ok(RuntimeTurnQueueState {
        queued_turns: payload.turns,
        active_goal_turns: payload.active_goal_turns,
        commands: payload.commands,
    })
}

#[cfg(test)]
pub(super) fn write_runtime_turn_queue(
    queue_path: &Path,
    turns: &VecDeque<SpawnTurnRequest>,
) -> Result<(), String> {
    write_runtime_turn_state(queue_path, turns, &HashMap::new(), &Default::default())
}

pub(super) fn write_runtime_turn_state(
    queue_path: &Path,
    turns: &VecDeque<SpawnTurnRequest>,
    active_goal_turns: &HashMap<String, SpawnTurnRequest>,
    commands: &command_journal::CommandJournal,
) -> Result<(), String> {
    let _write_guard = RUNTIME_TURN_QUEUE_WRITE_LOCK
        .get_or_init(|| StdMutex::new(()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let parent = queue_path
        .parent()
        .ok_or_else(|| "Runtime turn queue path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let key = load_or_create_runtime_turn_queue_key(queue_path)?;
    let mut payload = RuntimeTurnQueuePayload {
        version: RUNTIME_TURN_QUEUE_VERSION,
        turns: turns.clone(),
        active_goal_turns: active_goal_turns.clone(),
        commands: commands.clone(),
    };
    for turn in payload
        .turns
        .iter_mut()
        .chain(payload.active_goal_turns.values_mut())
        .chain(
            payload
                .commands
                .values_mut()
                .map(|command| &mut command.turn),
        )
    {
        submitted_model::redact_persisted_submitted_interface(turn);
    }
    let plaintext = serde_json::to_vec(&payload)
        .map_err(|error| format!("Failed to serialize runtime turn queue: {error}"))?;
    let mut nonce = [0_u8; 12];
    getrandom::fill(&mut nonce)
        .map_err(|error| format!("Failed to generate runtime turn queue nonce: {error}"))?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| format!("Failed to initialize runtime turn queue cipher: {error}"))?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            aes_gcm::aead::Payload {
                msg: &plaintext,
                aad: RUNTIME_TURN_QUEUE_AAD,
            },
        )
        .map_err(|_| "Failed to encrypt runtime turn queue".to_owned())?;
    let envelope = serde_json::to_vec_pretty(&EncryptedRuntimeTurnQueue {
        version: RUNTIME_TURN_QUEUE_VERSION,
        nonce: BASE64.encode(nonce),
        ciphertext: BASE64.encode(ciphertext),
    })
    .map_err(|error| format!("Failed to serialize encrypted runtime turn queue: {error}"))?;
    write_private_atomic(queue_path, &envelope)
}

pub(super) fn remove_worktree_turns_after_restart(
    worktrees: &WorktreeManager,
    turns: &mut VecDeque<SpawnTurnRequest>,
) -> usize {
    let initial_count = turns.len();
    turns.retain(|turn| {
        if turn.request.extra.contains_key(quota_recovery::MARKER)
            || turn
                .request
                .extra
                .get(RESUME_GOAL_ONLY_MARKER)
                .and_then(Value::as_bool)
                == Some(true)
        {
            return true;
        }
        let deferred_worktree = turn
            .request
            .extra
            .contains_key("deferred_worktree_source_path");
        let managed_worktree = turn
            .request
            .project_workspace_path
            .as_deref()
            .is_some_and(|path| worktrees.is_managed_path(Path::new(path)));
        !deferred_worktree && !managed_worktree
    });
    initial_count - turns.len()
}

fn read_runtime_turn_queue_key(queue_path: &Path) -> Result<[u8; 32], String> {
    let key_path = runtime_turn_queue_key_path(queue_path);
    let key = fs::read(&key_path)
        .map_err(|error| format!("Failed to read {}: {error}", key_path.display()))?;
    key.try_into()
        .map_err(|_| "Runtime turn queue key must be 32 bytes".to_owned())
}

fn load_or_create_runtime_turn_queue_key(queue_path: &Path) -> Result<[u8; 32], String> {
    match read_runtime_turn_queue_key(queue_path) {
        Ok(key) => return Ok(key),
        Err(_) if runtime_turn_queue_key_path(queue_path).exists() => {
            return read_runtime_turn_queue_key(queue_path);
        }
        Err(_) => {}
    }
    let mut key = [0_u8; 32];
    getrandom::fill(&mut key)
        .map_err(|error| format!("Failed to generate runtime turn queue key: {error}"))?;
    write_private_atomic(&runtime_turn_queue_key_path(queue_path), &key)?;
    Ok(key)
}

fn write_private_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("runtime-turn-queue");
    let temp_path = path.with_file_name(format!(
        ".{file_name}.{}.{}.{}.tmp",
        std::process::id(),
        now_ms(),
        RUNTIME_TURN_QUEUE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&temp_path)
        .map_err(|error| format!("Failed to create {}: {error}", temp_path.display()))?;
    file.write_all(content)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Failed to write {}: {error}", temp_path.display()))?;
    fs::rename(&temp_path, path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        format!("Failed to replace {}: {error}", path.display())
    })
}

pub(super) fn hook_user(request: &ExecutionRequest) -> HookUser {
    let nested_user = request.extra.get("user").and_then(Value::as_object);
    let id = request
        .extra
        .get("user_id")
        .or_else(|| nested_user.and_then(|user| user.get("id")))
        .and_then(hook_user_id);
    let name = request
        .user_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            nested_user.and_then(|user| {
                ["name", "user_name", "username"]
                    .iter()
                    .find_map(|key| user.get(*key).and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
        })
        .unwrap_or("anonymous")
        .to_owned();
    HookUser { id, name }
}

fn hook_user_id(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_owned())
        }
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum TurnAdmission {
    Normal,
    Forced,
    Queue,
    Continuation,
}

const USE_SAVED_STAND_IN_PERMISSIONS: &str = "useSavedStandInTaskPermissions";

impl RuntimeWorkRpcHandler {
    pub(super) async fn persist_turn_queue(
        &self,
        turns: VecDeque<SpawnTurnRequest>,
        previous: Option<&RuntimeTurnScheduler>,
        starting: &[SpawnTurnRequest],
    ) -> Result<(), AppIpcError> {
        let quota_turns = turns.clone();
        let admissions = previous.map(|previous| {
            (
                previous
                    .queued_turns
                    .iter()
                    .map(|turn| turn.local_task_id.clone())
                    .collect(),
                turns
                    .iter()
                    .map(|turn| {
                        (
                            turn.local_task_id.clone(),
                            turn.request
                                .extra
                                .get(RESUME_GOAL_ONLY_MARKER)
                                .and_then(Value::as_bool)
                                == Some(true),
                        )
                    })
                    .collect(),
            )
        });
        let mut commands = self
            .command_journal
            .lock()
            .expect("command journal lock should not be poisoned")
            .clone();
        command_journal::project_queue(&mut commands, &turns, starting)?;
        let committed_commands = commands.clone();
        let owner_admissions: Vec<_> = turns
            .iter()
            .chain(starting)
            .filter_map(|turn| {
                turn.request
                    .extra
                    .get("standInOwnerRequest")
                    .map(|owner| (turn.local_task_id.clone(), owner.clone()))
            })
            .collect();
        let queue_path = Arc::clone(&self.turn_queue_path);
        let active_goal_turns = self
            .active_goal_turns
            .lock()
            .expect("active Goal turn map lock should not be poisoned")
            .clone();
        tokio::task::spawn_blocking(move || {
            write_runtime_turn_state(&queue_path, &turns, &active_goal_turns, &commands)
        })
        .await
        .map_err(|error| {
            AppIpcError::new(
                "runtime_queue_failed",
                format!("Runtime queue writer task failed: {error}"),
            )
        })?
        .map_err(|error| AppIpcError::new("runtime_queue_failed", error))?;
        *self
            .command_journal
            .lock()
            .expect("command journal lock should not be poisoned") = committed_commands;
        for (task, owner) in &owner_admissions {
            self.record_stand_in_owner_admission(task, owner);
        }
        // Only admitted turns replace the current request. Queued follow-ups
        // retain their own context without changing the active native turn.
        for turn in starting {
            self.store.update_task(&turn.local_task_id, |link| {
                // Admission owns capacity before preparation or the native RPC starts.
                crate::runtime_work::lifecycle::begin_native_request(link);
                store_runtime_execution_request(&mut link.runtime_handle, &turn.request);
            });
        }
        if let Some((previous, current)) = admissions {
            self.sync_native_queue_admissions(previous, current);
        }
        self.project_quota_waits(&quota_turns);
        self.ensure_quota_waker();
        self.quota_wake.notify_one();
        Ok(())
    }

    pub(super) async fn spawn_turn(&self, turn: SpawnTurnRequest) -> Result<(), AppIpcError> {
        self.schedule_turn(turn, TurnAdmission::Normal, false)
            .await
            .map(|_| ())
    }

    pub(super) async fn spawn_forced_turn(
        &self,
        turn: SpawnTurnRequest,
    ) -> Result<(), AppIpcError> {
        self.schedule_turn(turn, TurnAdmission::Forced, false)
            .await
            .map(|_| ())
    }

    pub(super) async fn queue_turn(&self, turn: SpawnTurnRequest) -> Result<(), AppIpcError> {
        self.schedule_turn(turn, TurnAdmission::Queue, false)
            .await
            .map(|_| ())
    }

    pub(super) async fn submit_continuation(
        &self,
        turn: SpawnTurnRequest,
        use_saved_stand_in_permissions: bool,
    ) -> Result<(), AppIpcError> {
        self.schedule_turn(
            turn,
            TurnAdmission::Continuation,
            use_saved_stand_in_permissions,
        )
        .await
        .map(|_| ())
    }

    pub(super) async fn schedule_turn(
        &self,
        mut turn: SpawnTurnRequest,
        admission: TurnAdmission,
        use_saved_stand_in_permissions: bool,
    ) -> Result<bool, AppIpcError> {
        // Only native admission may opt into owner-granted permissions. The queue
        // retains this decision for restart and re-reads the current grant at launch.
        turn.request.extra.remove(USE_SAVED_STAND_IN_PERMISSIONS);
        if use_saved_stand_in_permissions {
            turn.request
                .extra
                .insert(USE_SAVED_STAND_IN_PERMISSIONS.into(), Value::Bool(true));
        }
        turn.bind_task_kind(&self.store);
        // Binding restores immutable origin; recompute the host's per-run manual fact
        // before the admission snapshot drops transient confirmation metadata.
        if turn.request.extra.get("standInManualConfirmation") == Some(&Value::Bool(true)) {
            self.refresh_stand_in_confirmation(&turn.local_task_id, &mut turn.request)?;
        }
        self.apply_project_workspace_roots(&mut turn.request);
        let local_task_id = turn.local_task_id.clone();
        let _operation = self.turn_queue_operation.lock().await;
        // Request preparation can overlap the previous turn's queue drain.
        // Use the live ownership state while holding the admission lock.
        let queue_only = admission == TurnAdmission::Queue
            || (admission == TurnAdmission::Continuation
                && (self.is_busy_local_task(&local_task_id)
                    || self.native_task_holds_capacity(&local_task_id)));
        if self.existing_command(&turn)?.is_some() {
            return Ok(false);
        }
        let goal_resume =
            turn.request.extra.get(RESUME_GOAL_ONLY_MARKER) == Some(&Value::Bool(true));
        if goal_resume {
            let needs_attention = self
                .active_goal_turns
                .lock()
                .expect("active Goal turn map lock should not be poisoned")
                .get(&local_task_id)
                .is_some_and(|turn| {
                    turn.request.extra.get(GOAL_NEEDS_ATTENTION_MARKER) == Some(&Value::Bool(true))
                });
            // Check under admission so concurrent activations cannot enqueue
            // duplicate resumes behind an already owned native continuation.
            if !needs_attention
                && (self.is_active_local_task(&local_task_id)
                    || self.native_task_holds_capacity(&local_task_id)
                    || self.queued_local_task_position(&local_task_id).is_some())
            {
                return Ok(false);
            }
        }
        // Existing threads retain their native model, even without a per-turn selection.
        let resolved_default = is_codex_runtime(&turn.runtime)
            && turn.direct_thread_id.is_none()
            && turn.fork_thread_id.is_none()
            && turn.resume_thread_id.is_none()
            && (turn.request.new_session
                || !self.local_task_link(&local_task_id).is_some_and(|link| {
                    super::super::conversation_sessions::is_identity_conversation(&link)
                }))
            && self
                .resolve_retired_codex_default(&mut turn.request)
                .await?;
        if resolved_default {
            self.retain_runtime_model_config(&local_task_id, &turn.request.model_config);
            self.store.update_task(&local_task_id, |link| {
                store_runtime_execution_request(&mut link.runtime_handle, &turn.request);
            });
        }
        if turn.request.extra.get("standInAutomatic") == Some(&Value::Bool(true)) {
            let user = turn
                .request
                .extra
                .get("user_id")
                .and_then(Value::as_i64)
                .ok_or_else(|| {
                    AppIpcError::new(
                        "permission_denied",
                        "Automatic input requires an execution identity",
                    )
                })?;
            let store = LocalTaskStore::open(self.task_store_path.as_ref())
                .map_err(super::stand_in::settings_error)?;
            let settings = store
                .personal_stand_in(user, &self.device_id)
                .map_err(super::stand_in::settings_error)?;
            turn.request.extra.insert(
                "standInAutomaticVersion".into(),
                json!(LocalTaskStore::coordination_configuration_version(
                    &settings
                )),
            );
        }
        if turn.request.extra.contains_key("standInSchedule") {
            let scheduler = self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned");
            if queue_only
                || !scheduler.has_capacity(&turn)
                || scheduler.has_ready_queued_kind(turn.task_kind())
            {
                return Err(AppIpcError::new("runtime_schedule_capacity", "Scheduled work cannot enter a delayed queue; retry when execution capacity is available"));
            }
        }
        let journaled_goal = self.turn_runs_active_goal(&turn);
        let previous_goal_status = self
            .store
            .read_task(&local_task_id, |link| link.goal_execution_status.clone())
            .flatten();
        let previous_goal = if journaled_goal {
            let previous = self
                .active_goal_turns
                .lock()
                .expect("active Goal turn map lock should not be poisoned")
                .insert(local_task_id.clone(), turn.clone());
            self.set_goal_execution_status(
                &local_task_id,
                if goal_resume {
                    Some("recovering")
                } else {
                    Some("running")
                },
            );
            previous
        } else {
            None
        };
        let (previous, turn_to_start, queued_turns, mut admission_diagnostics) = {
            let mut scheduler = self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned");
            let previous = scheduler.clone();
            scheduler.refresh_automatic_waits(&self.store, Some(&local_task_id));
            if !turn.request.extra.contains_key(quota_recovery::MARKER) {
                scheduler.queued_turns.retain(|queued| {
                    queued.local_task_id != local_task_id
                        || !queued.request.extra.contains_key(quota_recovery::MARKER)
                });
            }
            let kind = turn.task_kind();
            let task_reserved = scheduler.active_task_ids.contains_key(&local_task_id);
            let active_kind_count = scheduler.active(kind);
            let kind_limit = scheduler.settings.limit(kind);
            let ready_predecessor = scheduler.has_ready_queued_kind(kind);
            let quota_ready = quota_recovery::is_ready(&turn, now_ms());
            let automatic_input =
                turn.request.extra.get("standInAutomatic") == Some(&Value::Bool(true));
            let turn_to_start = if queue_only {
                scheduler.enqueue_queued(turn);
                None
            } else if admission == TurnAdmission::Forced {
                Some(scheduler.enqueue_forced(turn))
            } else {
                scheduler.enqueue(turn)
            };
            let admission_diagnostics = turn_to_start.is_none().then(|| {
                json!({
                    "method": match admission {
                        TurnAdmission::Normal => "normal",
                        TurnAdmission::Forced => "forced",
                        TurnAdmission::Queue => "queue",
                        TurnAdmission::Continuation => "continuation",
                    },
                    "queueOnly": queue_only,
                    "taskReserved": task_reserved,
                    "activeKindCount": active_kind_count,
                    "kindLimit": kind_limit,
                    "readyPredecessor": ready_predecessor,
                    "quotaReady": quota_ready,
                    "automaticInput": automatic_input,
                })
            });
            let queued_turns = scheduler.queued_turns.clone();
            (previous, turn_to_start, queued_turns, admission_diagnostics)
        };
        if let Some(diagnostics) = admission_diagnostics.as_mut() {
            // Read ownership without the scheduler mutex, before persistence
            // projects the queued follow-up onto native execution state.
            diagnostics["ownership"] = self.turn_admission_ownership(&local_task_id);
        }
        if let Err(error) = self
            .persist_turn_queue(
                queued_turns,
                Some(&previous),
                &turn_to_start.iter().cloned().collect::<Vec<_>>(),
            )
            .await
        {
            *self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned") = previous;
            if journaled_goal {
                let mut goals = self
                    .active_goal_turns
                    .lock()
                    .expect("active Goal turn map lock should not be poisoned");
                if let Some(previous) = previous_goal {
                    goals.insert(local_task_id.clone(), previous);
                } else {
                    goals.remove(&local_task_id);
                }
                drop(goals);
                self.set_goal_execution_status(&local_task_id, previous_goal_status.as_deref());
            }
            return Err(error);
        }
        if let Some(turn) = turn_to_start.as_ref() {
            self.reserve_turn_preparation(turn);
        }
        drop(_operation);
        if let Some(turn) = turn_to_start {
            if turn
                .request
                .extra
                .contains_key(project_preparation::DEFERRED_ENVIRONMENT)
            {
                self.start_queued_turn(turn);
            } else if project_preparation::needs_preparation(&turn) {
                self.prepare_and_start_reserved_turn(turn).await?;
            } else {
                self.start_turn(turn);
            }
        } else {
            log_executor_event(
                "runtime work turn queued",
                &[
                    ("local_task_id", local_task_id),
                    (
                        "admission",
                        admission_diagnostics
                            .expect("queued turn has admission facts")
                            .to_string(),
                    ),
                ],
            );
        }
        Ok(true)
    }

    fn turn_admission_ownership(&self, local_task_id: &str) -> Value {
        let (native, interaction_waiting) = self
            .store
            .read_task(local_task_id, |link| {
                (
                    crate::runtime_work::lifecycle::native_execution_state(link),
                    link.interaction_status
                        .as_deref()
                        .is_some_and(|status| !status.is_empty()),
                )
            })
            .unwrap_or_default();
        let preparing = self
            .preparing_turns
            .lock()
            .expect("preparation map poisoned")
            .contains_key(local_task_id);
        json!({
            "localExecutionActive": self.is_active_local_task(local_task_id),
            "localPreparationActive": preparing,
            "localCodexTurnPresent": self.active_codex_turn(local_task_id).is_some(),
            "nativePhase": native.as_ref().map(|state| state.phase),
            "nativeGenerationPresent": native.as_ref().is_some_and(|state| state.process_generation.is_some()),
            "nativeOutcome": native.as_ref().and_then(|state| state.execution_outcome.as_ref().or(state.outcome.as_ref())),
            "interactionWaiting": interaction_waiting,
        })
    }

    fn log_turn_cleanup_stage(&self, task_id: &str, execution_id: u64, stage: &str) {
        log_executor_event(
            "runtime work turn cleanup",
            &[
                ("local_task_id", task_id.to_owned()),
                ("stage", stage.to_owned()),
                (
                    "local_execution_owned",
                    self.is_current_local_task_execution(task_id, execution_id)
                        .to_string(),
                ),
            ],
        );
    }

    fn turn_runs_active_goal(&self, turn: &SpawnTurnRequest) -> bool {
        if turn
            .request
            .extra
            .get(RESUME_GOAL_ONLY_MARKER)
            .and_then(Value::as_bool)
            == Some(true)
        {
            return true;
        }
        if let Some(goal) = turn.initial_thread_goal.as_ref() {
            return string_field(goal, "status").as_deref().unwrap_or("active") == "active";
        }
        self.local_task_link(&turn.local_task_id)
            .and_then(|link| link.goal_status)
            .as_deref()
            == Some("active")
    }

    pub(super) fn record_active_goal_thread(&self, local_task_id: &str, thread_id: &str) {
        let updated = {
            let mut active_goal_turns = self
                .active_goal_turns
                .lock()
                .expect("active Goal turn map lock should not be poisoned");
            let Some(turn) = active_goal_turns.get_mut(local_task_id) else {
                return;
            };
            turn.direct_thread_id = None;
            turn.fork_thread_id = None;
            turn.fork_thread_path = None;
            turn.resume_thread_id = Some(thread_id.to_owned());
            turn.initial_thread_goal = None;
            turn.clone()
        };
        self.set_goal_execution_status(local_task_id, Some("running"));
        let handler = self.clone();
        tokio::spawn(async move {
            if let Err(error) = handler.persist_current_turn_state().await {
                log_executor_event(
                    "active Goal turn persistence failed",
                    &[
                        ("local_task_id", updated.local_task_id),
                        ("error", error.message),
                    ],
                );
            }
        });
    }

    pub(super) fn journal_active_goal_turn(
        &self,
        local_task_id: &str,
        active_turn: Option<&ActiveCodexTurn>,
    ) {
        let request = self
            .active_local_executions
            .lock()
            .expect("active local execution map lock should not be poisoned")
            .get(local_task_id)
            .and_then(|execution| execution.request.clone());
        let Some(mut request) = request.or_else(|| {
            let link = self.local_task_link(local_task_id)?;
            // A paused native Goal can be reactivated after its local send
            // has finished. Reuse its saved execution profile, never replay
            // the old user command or invent a profile for an unowned thread.
            execution_request(&link.runtime_handle)?;
            let mut request = runtime_event_request_from_link(&link);
            if let Some(config) = self.runtime_model_config(local_task_id) {
                request.model_config = config;
            }
            request.subtask_id = format!("{local_task_id}-goal-recovery");
            request.prompt = Value::String(String::new());
            request.extra.remove("runtime_command_id");
            request.extra.remove("runtime_command_input");
            request
                .extra
                .insert(RESUME_GOAL_ONLY_MARKER.to_owned(), Value::Bool(true));
            Some(request)
        }) else {
            return;
        };
        // Event triggers belong to the first admitted input. Autonomous Goal
        // recovery retains its command receipt without resubmitting that input.
        request.extra.remove("resource_event_keys");
        let thread_id = active_turn.map(|turn| turn.thread_id.clone()).or_else(|| {
            self.local_task_link(local_task_id)
                .and_then(|link| link.thread_id)
        });
        let persisted_turn = SpawnTurnRequest {
            task_kind: None,
            local_task_id: local_task_id.to_owned(),
            runtime: "codex".to_owned(),
            request,
            send_payload: None,
            direct_thread_id: None,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: thread_id,
            initial_thread_goal: None,
        };
        // Native metadata may arrive through a passive or compaction content route.
        // Only admission owns replacement of an existing recovery request.
        let mut inserted = false;
        self.active_goal_turns
            .lock()
            .expect("active Goal turn map lock should not be poisoned")
            .entry(local_task_id.to_owned())
            .or_insert_with(|| {
                inserted = true;
                persisted_turn
            });
        if inserted {
            self.set_goal_execution_status(local_task_id, Some("running"));
        }
        let handler = self.clone();
        let local_task_id = local_task_id.to_owned();
        tokio::spawn(async move {
            if let Err(error) = handler.persist_current_turn_state().await {
                log_executor_event(
                    "active Goal notification persistence failed",
                    &[("local_task_id", local_task_id), ("error", error.message)],
                );
            }
        });
    }

    pub(super) fn clear_active_goal_turn(&self, local_task_id: &str) {
        self.release_goal_model_routes(local_task_id);
        let removed = self
            .active_goal_turns
            .lock()
            .expect("active Goal turn map lock should not be poisoned")
            .remove(local_task_id)
            .is_some();
        self.set_goal_execution_status(local_task_id, None);
        if !removed {
            return;
        }
        let handler = self.clone();
        let local_task_id = local_task_id.to_owned();
        tokio::spawn(async move {
            if let Err(error) = handler.persist_current_turn_state().await {
                log_executor_event(
                    "active Goal turn cleanup persistence failed",
                    &[("local_task_id", local_task_id), ("error", error.message)],
                );
            }
        });
    }

    pub(super) fn mark_active_goal_turn_needs_attention(&self, local_task_id: &str) {
        {
            let mut active_goal_turns = self
                .active_goal_turns
                .lock()
                .expect("active Goal turn map lock should not be poisoned");
            let Some(turn) = active_goal_turns.get_mut(local_task_id) else {
                return;
            };
            turn.request
                .extra
                .insert(GOAL_NEEDS_ATTENTION_MARKER.to_owned(), Value::Bool(true));
        }
        self.set_goal_execution_status(local_task_id, Some("needsAttention"));
        let handler = self.clone();
        tokio::spawn(async move {
            if let Err(error) = handler.persist_current_turn_state().await {
                log_executor_event(
                    "active Goal attention state persistence failed",
                    &[("error", error.message)],
                );
            }
        });
    }

    // Fixtures enqueue recovery directly to verify admission and durable failure handling.
    #[cfg(test)]
    pub(super) async fn resume_active_goal(
        &self,
        local_task_id: &str,
    ) -> Result<bool, AppIpcError> {
        let turn = {
            let active_goal_turns = self
                .active_goal_turns
                .lock()
                .expect("active Goal turn map lock should not be poisoned");
            let Some(turn) = active_goal_turns.get(local_task_id) else {
                return Ok(false);
            };
            turn.clone()
        };
        let mut turn = turn;
        turn.request.extra.remove("resource_event_keys");
        turn.request.extra.remove(GOAL_NEEDS_ATTENTION_MARKER);
        turn.request
            .extra
            .insert(RESUME_GOAL_ONLY_MARKER.to_owned(), Value::Bool(true));
        // A native Goal mutation may update only disk state when its session
        // has unloaded. Resume it through the existing owner and admission flow.
        self.schedule_turn(turn, TurnAdmission::Normal, false).await
    }

    pub(super) async fn persist_current_turn_state(&self) -> Result<(), AppIpcError> {
        let _operation = self.turn_queue_operation.lock().await;
        let queued_turns = self
            .turn_scheduler
            .lock()
            .expect("runtime turn scheduler lock should not be poisoned")
            .queued_turns
            .clone();
        self.persist_turn_queue(queued_turns, None, &[]).await
    }

    pub(super) fn set_goal_execution_status(&self, local_task_id: &str, status: Option<&str>) {
        self.store.update_task(local_task_id, |link| {
            link.goal_execution_status = status.map(ToOwned::to_owned);
            link.updated_at = now_ms().max(link.updated_at);
        });
    }

    pub(super) fn set_interaction_status(&self, local_task_id: &str, status: Option<&str>) {
        let _guard = self
            .stand_in_lifecycle_gate
            .lock()
            .expect("turn lifecycle gate poisoned");
        let mut changed = false;
        self.store.update_task(local_task_id, |link| {
            let next_status = status.map(ToOwned::to_owned);
            if link.interaction_status == next_status {
                return;
            }
            link.interaction_status = next_status;
            link.updated_at = now_ms().max(link.updated_at);
            changed = true;
        });
        if changed {
            emit_runtime_work_changed(&self.event_tx, &self.device_id, local_task_id);
        }
    }

    pub(super) async fn prepare_deferred_worktree(
        &self,
        turn: &mut SpawnTurnRequest,
    ) -> Result<(), AppIpcError> {
        let Some(source_path) = turn
            .request
            .extra
            .remove("deferred_worktree_source_path")
            .and_then(|value| value.as_str().map(ToOwned::to_owned))
        else {
            return Ok(());
        };
        let git_ref = turn
            .request
            .extra
            .remove("deferred_worktree_ref")
            .and_then(|value| value.as_str().map(ToOwned::to_owned));
        let planned_path = turn
            .request
            .extra
            .remove("deferred_worktree_path")
            .and_then(|value| value.as_str().map(PathBuf::from));
        let repo_root_fingerprint = turn
            .request
            .extra
            .remove("deferred_worktree_repo_root_fingerprint")
            .and_then(|value| value.as_str().map(ToOwned::to_owned));
        let worktrees = self.worktrees.clone();
        let worktree_id = turn.local_task_id.clone();
        let previous_root = source_path.clone();
        let record =
            tokio::task::spawn_blocking(move || match (planned_path, repo_root_fingerprint) {
                (Some(planned_path), Some(repo_root_fingerprint)) => worktrees.prepare_planned(
                    Path::new(&source_path),
                    &worktree_id,
                    git_ref.as_deref(),
                    false,
                    &planned_path,
                    &repo_root_fingerprint,
                ),
                (Some(planned_path), None) => worktrees.prepare_at(
                    Path::new(&source_path),
                    &worktree_id,
                    git_ref.as_deref(),
                    false,
                    &planned_path,
                ),
                (None, _) => worktrees.prepare(
                    Path::new(&source_path),
                    &worktree_id,
                    git_ref.as_deref(),
                    false,
                ),
            })
            .await
            .map_err(|error| {
                AppIpcError::new(
                    "worktree_prepare_failed",
                    format!("Worktree preparation task failed: {error}"),
                )
            })?
            .map_err(|error| AppIpcError::new(worktree_error_code(&error), error))?;
        turn.request.project_workspace_path = Some(record.path.clone());
        for root in &mut turn.request.runtime_workspace_roots {
            if crate::runtime_work::worktrees::same_path(root, &previous_root) {
                *root = record.path.clone();
            }
        }
        log_executor_event(
            "runtime worktree permission roots resolved",
            &[
                ("local_task_id", turn.local_task_id.clone()),
                ("source_path", previous_root),
                ("workspace_path", record.path.clone()),
                (
                    "runtime_workspace_roots",
                    json!(turn.request.runtime_workspace_roots).to_string(),
                ),
            ],
        );
        self.store.update_task(&turn.local_task_id, |link| {
            link.workspace_path = record.path.clone();
            link.updated_at = now_ms();
        });
        self.schedule_worktree_prune();
        Ok(())
    }

    pub(super) fn reserve_turn_preparation(&self, turn: &SpawnTurnRequest) {
        if !project_preparation::needs_preparation(turn)
            && !turn.request.extra.contains_key(quota_recovery::MARKER)
        {
            return;
        }
        self.store.update_task(&turn.local_task_id, |link| {
            if turn.request.extra.contains_key(quota_recovery::MARKER) {
                // Checking quota does not start the deferred native turn.
                crate::runtime_work::lifecycle::queue_native_execution(link, 0, false);
            } else {
                link.running = true;
                link.status = "active".to_owned();
                link.thread_status = "active".to_owned();
            }
            link.updated_at = now_ms();
        });
        self.preparing_turns
            .lock()
            .expect("preparing turn map lock should not be poisoned")
            .insert(
                turn.local_task_id.clone(),
                PreparingTurn {
                    owner_request: turn
                        .request
                        .extra
                        .get(stand_in_proposal_continuations::OWNER)
                        .cloned(),
                    cancellation_requested: false,
                },
            );
    }

    pub(super) fn cancel_preparing_turn(&self, local_task_id: &str) -> bool {
        let mut preparing = self
            .preparing_turns
            .lock()
            .expect("preparing turn map lock should not be poisoned");
        let Some(preparation) = preparing.get_mut(local_task_id) else {
            return false;
        };
        preparation.cancellation_requested = true;
        true
    }

    pub(super) async fn wait_for_worktree_preparation_to_finish(
        &self,
        local_task_id: &str,
    ) -> bool {
        for attempt in 0..=WORKTREE_PREPARATION_STOP_WAIT_ATTEMPTS {
            let preparing = self
                .preparing_turns
                .lock()
                .expect("preparing turn map lock should not be poisoned")
                .contains_key(local_task_id);
            if !preparing {
                return true;
            }
            if attempt == WORKTREE_PREPARATION_STOP_WAIT_ATTEMPTS {
                return false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(
                WORKTREE_PREPARATION_STOP_WAIT_MS,
            ))
            .await;
        }
        false
    }

    fn mark_deferred_worktree_failed(&self, turn: &SpawnTurnRequest, error: &AppIpcError) {
        let local_task_id = &turn.local_task_id;
        log_executor_event(
            "runtime turn preparation failed",
            &[
                ("local_task_id", local_task_id.clone()),
                ("code", error.code.clone()),
                ("error", error.message.clone()),
            ],
        );
        let failure_info = error_info(None, Some(&error.message));
        let mut failed_at = None;
        self.store.update_task(local_task_id, |link| {
            let diagnostic = link.runtime_handle["startupFailure"].clone();
            apply_local_task_failure(link, error);
            link.runtime_handle["startupFailure"] = diagnostic;
            let timestamp = link.completed_at.unwrap_or_else(now_ms);
            record_preparation_failure(link, &turn.request, error, &failure_info, timestamp);
            link.completed_at = Some(timestamp);
            link.updated_at = timestamp;
            failed_at = Some(timestamp);
        });
        if let Some(timestamp) = failed_at {
            self.persist_failed_assistant_message_with_timestamp(
                local_task_id,
                &turn.request,
                &error.message,
                failure_info.clone(),
                false,
                timestamp,
            );
        }
    }

    fn mark_deferred_worktree_cancelled(&self, local_task_id: &str) {
        self.store.update_task(local_task_id, |link| {
            settle_pending_native_admission(link, "cancelled");
            link.running = false;
            link.status = "cancelled".to_owned();
            link.thread_status = "cancelled".to_owned();
            link.turn_status = Some("cancelled".to_owned());
            link.updated_at = now_ms();
            link.completed_at = Some(link.updated_at);
            normalize_settled_task_state(link);
            if let Some(runtime_handle) = link.runtime_handle.as_object_mut() {
                runtime_handle.remove("queuePosition");
            }
        });
    }

    async fn cleanup_cancelled_worktree(&self, turn: &SpawnTurnRequest) {
        let Some(path) = turn
            .request
            .project_workspace_path
            .as_deref()
            .map(PathBuf::from)
        else {
            return;
        };
        if !self.worktrees.is_managed_path(&path) {
            return;
        }
        let worktrees = self.worktrees.clone();
        let cleanup_path = path.clone();
        let worktree_id = turn.local_task_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            worktrees
                .delete(&cleanup_path, false)
                .map(|_| ())
                .or_else(|delete_error| {
                    worktrees
                        .discard_failed_preparation(&cleanup_path, &worktree_id)
                        .map(|_| ())
                        .map_err(|discard_error| format!("{delete_error}; {discard_error}"))
                })
        })
        .await;
        if let Err(error) = result
            .map_err(|error| error.to_string())
            .and_then(|result| result.map_err(|error| error.to_string()))
        {
            log_executor_event(
                "cancelled deferred worktree cleanup failed",
                &[
                    ("local_task_id", turn.local_task_id.clone()),
                    ("path", path.display().to_string()),
                    ("error", error),
                ],
            );
        }
    }

    pub(super) async fn prepare_and_start_reserved_turn(
        &self,
        mut turn: SpawnTurnRequest,
    ) -> Result<(), AppIpcError> {
        let preparation = async {
            self.prepare_project_environment(&mut turn).await?;
            self.prepare_deferred_worktree(&mut turn).await?;
            self.prepare_creation_branch(&mut turn.request).await?;
            self.persist_prepared_project_workspace(&turn)?;
            self.store.update_task(&turn.local_task_id, |link| {
                link.workspace_path = turn.request.cwd().unwrap_or_default().to_owned();
                link.runtime_workspace_roots = turn.request.runtime_workspace_roots.clone();
                store_runtime_execution_request(&mut link.runtime_handle, &turn.request);
            });
            Ok::<(), AppIpcError>(())
        }
        .await;
        if preparation.is_ok() {
            {
                let mut preparing = self
                    .preparing_turns
                    .lock()
                    .expect("preparing turn map lock should not be poisoned");
                if !preparing
                    .get(&turn.local_task_id)
                    .is_some_and(|preparation| preparation.cancellation_requested)
                {
                    preparing.remove(&turn.local_task_id);
                    self.start_queued_turn(turn);
                    return Ok(());
                }
                preparing.remove(&turn.local_task_id);
            }
            self.cleanup_cancelled_worktree(&turn).await;
            self.mark_deferred_worktree_cancelled(&turn.local_task_id);
            self.finish_prepared_command(&turn, command_journal::CommandState::Cancelled)
                .await;
            return Ok(());
        }
        let cancelled = {
            let mut preparing = self
                .preparing_turns
                .lock()
                .expect("preparing turn map lock should not be poisoned");
            preparing
                .remove(&turn.local_task_id)
                .is_some_and(|preparation| preparation.cancellation_requested)
        };
        if cancelled {
            self.cleanup_cancelled_worktree(&turn).await;
            self.mark_deferred_worktree_cancelled(&turn.local_task_id);
            self.finish_prepared_command(&turn, command_journal::CommandState::Cancelled)
                .await;
            return Ok(());
        }
        let error = preparation.expect_err("failed preparation should contain an error");
        self.mark_deferred_worktree_failed(&turn, &error);
        self.finish_prepared_command(&turn, command_journal::CommandState::Failed)
            .await;
        Err(error)
    }

    pub(super) fn start_queued_turn(&self, turn: SpawnTurnRequest) {
        if turn.request.extra.contains_key(quota_recovery::MARKER) {
            let handler = self.clone();
            tokio::spawn(async move { handler.start_quota_turn(turn).await });
            return;
        }
        if project_preparation::needs_preparation(&turn) {
            let handler = self.clone();
            tokio::spawn(async move {
                let _ = handler.prepare_and_start_reserved_turn(turn).await;
            });
            return;
        }
        if turn
            .request
            .extra
            .get(RESTORED_TURN_MARKER)
            .and_then(Value::as_bool)
            == Some(true)
        {
            let handler = self.clone();
            tokio::spawn(async move {
                log_executor_event(
                    "runtime restored turn waiting for startup permit",
                    &[("local_task_id", turn.local_task_id.clone())],
                );
                let permit = match Arc::clone(&handler.restore_startup_semaphore)
                    .acquire_owned()
                    .await
                {
                    Ok(permit) => permit,
                    Err(_) => return,
                };
                handler.start_turn_with_restore_permit(turn, Some(permit));
            });
            return;
        }
        self.start_turn(turn);
    }

    pub(super) async fn observe_execution_codex_notification(
        &self,
        local_task_id: &str,
        execution_id: u64,
        request: &ExecutionRequest,
        active_turn: Option<ActiveCodexTurn>,
        message: CodexNotification,
    ) {
        if let (Some(turn), Some(thread)) =
            (active_turn.as_ref(), codex_notification_thread_id(&message))
        {
            self.register_scoped_child_route(turn, &thread);
        }
        // Request resources do not depend on the independently owned native publication.
        if !self.is_local_task_execution_accepting_notifications(local_task_id, execution_id) {
            return;
        }
        let (Some(turn), Some(cwd)) = (active_turn, request.cwd()) else {
            return;
        };
        let (model, _) = super::hooks::hook_model_identity(request);
        let context = CodexHookContext {
            user: hook_user(request),
            session_id: turn.thread_id,
            turn_id: turn.turn_id,
            cwd: PathBuf::from(cwd),
            model,
            permission_mode: "workspace-write".into(),
        };
        match post_tool_use_from_notification(&context, &message) {
            Ok(Some(input)) => self.hook_service.dispatch(input).await,
            Ok(None) => {}
            Err(error) => log_executor_event(
                "runtime work hook notification mapping failed",
                &[("error", error.to_string())],
            ),
        }
    }

    pub(super) fn request_for_codex_event(
        &self,
        local_task_id: &str,
        request: &ExecutionRequest,
        turn_id: Option<&str>,
    ) -> ExecutionRequest {
        let mut event_request = request.clone();
        event_request.extra.remove("standInGuidanceSources");
        if let Some(turn_id) = turn_id {
            event_request.subtask_id = turn_id.to_owned();
            if let Some(Some(sources)) = self.store.read_task(local_task_id, |link| {
                let replies = &link.runtime_handle["standInGuidanceReplies"];
                (replies["turnId"] == turn_id).then(|| replies["sources"].clone())
            }) {
                event_request
                    .extra
                    .insert("standInGuidanceSources".into(), sources);
            }
        }
        let client_id = request
            .extra
            .get("client_user_message_id")
            .or_else(|| request.extra.get("clientUserMessageId"))
            .and_then(Value::as_str);
        // A new send may reuse a request subtask before turn/start returns.
        // Only this client's native binding distinguishes an autonomous continuation.
        let continuation = turn_id.zip(client_id).is_some_and(|(turn_id, client_id)| {
            self.store.read_task(local_task_id, |link| {
                link.runtime_handle["userMessagePresentations"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|presentation| {
                        presentation
                            .get("clientUserMessageId")
                            .or_else(|| presentation.get("client_user_message_id"))
                            .and_then(Value::as_str)
                            == Some(client_id)
                    })
                    .and_then(|presentation| {
                        presentation
                            .get("turnId")
                            .or_else(|| presentation.get("turn_id"))
                    })
                    .and_then(Value::as_str)
                    .is_some_and(|initial| initial != turn_id)
            }) == Some(true)
        });
        if request
            .extra
            .get(RESUME_GOAL_ONLY_MARKER)
            .and_then(Value::as_bool)
            == Some(true)
            || continuation
        {
            event_request.extra.remove("client_user_message_id");
            event_request.extra.remove("clientUserMessageId");
            event_request.extra.remove("runtime_generated_user_message");
        }
        event_request
    }

    pub(super) fn start_turn(&self, turn: SpawnTurnRequest) {
        self.start_turn_with_restore_permit(turn, None);
    }

    pub(super) fn schedule_restore_startup_timeout(
        &self,
        local_task_id: String,
        execution_id: u64,
        restore_startup: Arc<RestoreStartupGate>,
    ) {
        let handler = self.clone();
        tokio::spawn(async move {
            sleep(RESTORE_STARTUP_TIMEOUT).await;
            if !restore_startup.try_timeout() {
                return;
            }
            if handler.is_current_local_task_execution(&local_task_id, execution_id) {
                handler.force_settle_local_task_execution(
                    &local_task_id,
                    None,
                    "failed",
                    "restore_startup_timeout",
                );
                log_executor_event(
                    "runtime restored turn startup timed out",
                    &[("local_task_id", local_task_id)],
                );
            }
        });
    }

    fn start_turn_with_restore_permit(
        &self,
        turn: SpawnTurnRequest,
        restore_permit: Option<tokio::sync::OwnedSemaphorePermit>,
    ) {
        if self.automatic_input_waits(&turn) {
            let handler = self.clone();
            tokio::spawn(async move {
                handler.park_waiting_automatic_turn(turn).await;
            });
            return;
        }
        if turn.request.extra.get("standInAutomatic") == Some(&Value::Bool(true)) {
            let handler = self.clone();
            tokio::spawn(async move {
                handler.start_automatic_turn(turn, restore_permit).await;
            });
            return;
        }
        self.start_authorized_turn(turn, restore_permit);
    }

    pub(super) fn start_authorized_turn(
        &self,
        mut turn: SpawnTurnRequest,
        restore_permit: Option<tokio::sync::OwnedSemaphorePermit>,
    ) {
        if turn
            .request
            .extra
            .remove(super::runtime_rpc::REMOTE_PERSONAL_RUNTIME_IDENTITY)
            == Some(Value::Bool(true))
            && !self
                .store
                .read_task(&turn.local_task_id, |link| {
                    personal_runtime_scope(&turn.request, &link.runtime_handle)
                })
                .unwrap_or(false)
        {
            turn.request.runtime_auth_token = None;
        }
        let _lifecycle_guard = self
            .stand_in_lifecycle_gate
            .lock()
            .expect("stand-in lifecycle gate poisoned");
        if let Err(error) = self.validate_stand_in_lifecycle(&turn.request, &turn.local_task_id) {
            self.retain_failed_runtime_task(&turn.local_task_id, &error);
            let handler = self.clone();
            tokio::spawn(async move {
                handler
                    .finish_prepared_command(&turn, command_journal::CommandState::Failed)
                    .await;
                handler.finish_scheduled_turn(&turn.local_task_id).await;
            });
            return;
        }
        if self.automatic_input_waits(&turn) {
            let handler = self.clone();
            tokio::spawn(async move {
                handler.park_waiting_automatic_turn(turn).await;
            });
            return;
        }
        if !self.stand_in_owner_request_matches(&turn.request, &turn.local_task_id) {
            let handler = self.clone();
            tokio::spawn(async move {
                handler
                    .finish_prepared_command(&turn, command_journal::CommandState::Cancelled)
                    .await;
                handler.finish_scheduled_turn(&turn.local_task_id).await;
            });
            return;
        }
        if let Err(error) =
            self.validate_stand_in_schedule_start(&turn.request, &turn.local_task_id)
        {
            self.reject_stand_in_schedule_turn(&turn.request, &turn.local_task_id, error);
            return;
        }
        let use_saved_stand_in_permissions = turn.request.extra.get(USE_SAVED_STAND_IN_PERMISSIONS)
            == Some(&Value::Bool(true))
            && !turn.request.extra.contains_key("resource_event_keys");
        turn.request.stand_in_task_permissions = if use_saved_stand_in_permissions {
            self.store
                .read_task(
                    &turn.local_task_id,
                    super::stand_in_task_permissions::task_permissions,
                )
                .flatten()
        } else {
            None
        };
        if let Some(payload) = turn.send_payload.as_ref() {
            if !turn.request.new_session {
                if let Some(link) = self
                    .local_task_link(&turn.local_task_id)
                    .filter(super::super::conversation_sessions::is_identity_conversation)
                {
                    turn.resume_thread_id = link.thread_id;
                }
            }
            let thread_id = turn
                .resume_thread_id
                .as_deref()
                .or(turn.direct_thread_id.as_deref())
                .or(turn.fork_thread_id.as_deref())
                .unwrap_or_default();
            let workspace_path = turn
                .request
                .project_workspace_path
                .as_deref()
                .unwrap_or_default();
            self.mark_task_running_for_send(
                &turn.local_task_id,
                thread_id,
                workspace_path,
                &turn.request,
                payload,
            );
            self.store.update_task(&turn.local_task_id, |link| {
                store_runtime_execution_request(&mut link.runtime_handle, &turn.request);
            });
        }
        turn.request.extra.remove(RESTORED_TURN_MARKER);
        let restore_startup = restore_permit.map(RestoreStartupGate::new);
        turn.request.extra.insert(
            "runtimeLocalTaskId".to_owned(),
            Value::String(turn.local_task_id.clone()),
        );
        self.apply_backend_connection(&mut turn.request);
        let original_quota_model = turn
            .request
            .extra
            .contains_key(quota_recovery::MARKER)
            .then(|| turn.request.model_config.clone());
        let execution_context = self
            .resolve_local_model_reference(&mut turn.request, &turn.local_task_id)
            .and_then(|()| {
                original_quota_model.as_ref().map_or(Ok(()), |original| {
                    quota_recovery::validate_model(original, &turn.request.model_config)
                })
            })
            .map_err(|error| error.message)
            .and_then(|_| self.refresh_stand_in_context(&mut turn.request));
        crate::runtime_work::api_context::inject_current_session(
            &mut turn.request,
            &self.device_id,
            &turn.local_task_id,
        );
        if is_claude_runtime(&turn.runtime) {
            self.start_claude_turn(turn.local_task_id, turn.request, restore_startup);
            return;
        }
        let witness = crate::task_runtime::mcp::begin_stand_in_turn_witness(&mut turn.request);
        let recovery_turn = turn.clone();
        let recovery_account = codex_accounts::quota_account_identity(&turn.request);
        let owner_input = turn
            .send_payload
            .as_ref()
            .is_some_and(|payload| payload[super::control::connection_events::OWNER_INPUT] == true);
        let SpawnTurnRequest {
            task_kind: _,
            local_task_id,
            runtime: _,
            mut request,
            send_payload: _,
            direct_thread_id,
            fork_thread_id,
            fork_thread_path,
            resume_thread_id,
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

        let (request_user_input_tx, request_user_input_rx): (
            mpsc::Sender<Value>,
            CodexRequestUserInputReceiver,
        ) = mpsc::channel(1);
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (stopped_tx, stopped_rx) = oneshot::channel();
        let execution_id = if request.extra.contains_key(quota_recovery::MARKER) {
            let mut preparing = self
                .preparing_turns
                .lock()
                .expect("preparation map poisoned");
            if preparing
                .get(&local_task_id)
                .map_or(true, |preparation| preparation.cancellation_requested)
            {
                preparing.remove(&local_task_id);
                drop(preparing);
                self.store.update_task(&local_task_id, |link| {
                    crate::runtime_work::lifecycle::settle_native_execution(link, "cancelled");
                });
                let handler = self.clone();
                tokio::spawn(async move { handler.finish_quota_command(&recovery_turn).await });
                return;
            }
            let execution =
                self.start_local_task_execution(local_task_id.clone(), cancel_tx, stopped_rx);
            preparing.remove(&local_task_id);
            execution
        } else {
            self.start_local_task_execution(local_task_id.clone(), cancel_tx, stopped_rx)
        };
        self.active_local_executions
            .lock()
            .expect("active local execution map lock should not be poisoned")
            .get_mut(&local_task_id)
            .expect("the newly admitted execution must exist")
            .request = Some(request.clone());
        if let Some(restore_startup) = restore_startup.as_ref() {
            self.schedule_restore_startup_timeout(
                local_task_id.clone(),
                execution_id,
                Arc::clone(restore_startup),
            );
        }
        if let Ok(mut requests) = self.active_request_user_inputs.lock() {
            requests.insert(
                local_task_id.clone(),
                ActiveRequestUserInput {
                    execution_id,
                    sender: request_user_input_tx,
                },
            );
        }
        let handler = self.clone();
        let turn_local_task_id = local_task_id.clone();
        let turn_handle = tokio::spawn(async move {
            let _witness = witness;
            let _stopped_turn_guard = StoppedTurnGuard::new(stopped_tx);
            let mut scheduled_turn_guard = ScheduledTurnGuard::new(
                handler.clone(),
                turn_local_task_id.clone(),
                execution_id,
                request
                    .extra
                    .get("runtime_command_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            );
            if let Err(error) = handler
                .refresh_shared_conversation_request(&mut request)
                .await
            {
                handler.store.update_task(&turn_local_task_id, |link| {
                    let active = handler
                        .active_local_executions
                        .lock()
                        .expect("active local execution map lock should not be poisoned");
                    if active
                        .get(&turn_local_task_id)
                        .is_some_and(|control| control.execution_id == execution_id)
                    {
                        apply_local_task_failure(link, &error);
                    }
                });
                scheduled_turn_guard.command_outcome = Some(command_journal::CommandState::Failed);
                return;
            }
            handler.ensure_notification_router().await;
            let (notification_tx, mut notification_rx) =
                mpsc::unbounded_channel::<CodexNotification>();
            let mapper_handler = handler.clone();
            let mapper_local_task_id = turn_local_task_id.clone();
            let mapper_execution_id = execution_id;
            let hook_request = Arc::new(Mutex::new(Arc::new(request.clone())));
            let mapper_hook_request = Arc::clone(&hook_request);
            let hook_turn = Arc::new(Mutex::new(None::<ActiveCodexTurn>));
            let mapper_hook_turn = Arc::clone(&hook_turn);
            let lifecycle = Arc::new(Mutex::new(None::<crate::hooks::lifecycle::LifecycleHooks>));
            let mapper_lifecycle = Arc::clone(&lifecycle);
            let mapper_handle = tokio::spawn(async move {
                while let Some(message) = notification_rx.recv().await {
                    let mapper_request =
                        Arc::clone(&mapper_hook_request.lock().expect("hook request lock"));
                    let active_turn = mapper_hook_turn
                        .lock()
                        .expect("hook turn context lock should not be poisoned")
                        .clone();
                    if let Some(turn) = active_turn.as_ref() {
                        if let Some(hooks) =
                            mapper_lifecycle.lock().expect("lifecycle lock").as_mut()
                        {
                            hooks.observe_codex(&turn.thread_id, &message);
                        }
                    }
                    mapper_handler
                        .observe_execution_codex_notification(
                            &mapper_local_task_id,
                            mapper_execution_id,
                            &mapper_request,
                            active_turn,
                            message,
                        )
                        .await;
                }
            });
            let route_handler = handler.clone();
            let route_local_task_id = turn_local_task_id.clone();
            let route_request = request.clone();
            let is_new_thread = resume_thread_id.is_none() && direct_thread_id.is_none();
            let route_hook_request = Arc::clone(&hook_request);
            let thread_started: CodexThreadStartedCallback =
                Box::new(move |thread_id, model, provider| {
                    let native_model = model.clone();
                    let native_provider = provider.clone();
                    let resolved = Arc::new(super::hooks::resolved_codex_hook_request(
                        &route_request,
                        model,
                        provider,
                    ));
                    let (hook_model, hook_provider) = super::hooks::hook_model_identity(&resolved);
                    log_executor_event(
                        "runtime lifecycle hook model resolved",
                        &[
                            ("local_task_id", route_local_task_id.clone()),
                            ("thread_id", thread_id.clone()),
                            (
                                "model_kind",
                                route_request.model_config["wework_model_kind"]
                                    .as_str()
                                    .unwrap_or("unspecified")
                                    .to_owned(),
                            ),
                            (
                                "request_model",
                                super::string_field(&route_request.model_config, "model_id")
                                    .unwrap_or_default(),
                            ),
                            ("native_model", native_model.unwrap_or_default()),
                            ("native_provider", native_provider.unwrap_or_default()),
                            ("hook_model", hook_model.unwrap_or_default()),
                            ("hook_provider", hook_provider.unwrap_or_default()),
                            (
                                "compat_proxy",
                                (route_request.model_config["codex_responses_compat_proxy"]
                                    == true)
                                    .to_string(),
                            ),
                        ],
                    );
                    *route_hook_request.lock().expect("hook request lock") = Arc::clone(&resolved);
                    route_handler.record_local_task_thread(&route_local_task_id, &thread_id);
                    route_handler.record_active_goal_thread(&route_local_task_id, &thread_id);
                    route_handler.register_codex_thread_workspace_root(
                        &thread_id,
                        &resolved,
                        is_new_thread,
                    );
                });
            let active_turn_handler = handler.clone();
            let active_turn_local_task_id = turn_local_task_id.clone();
            let active_turn_execution_id = execution_id;
            let pending_turn_presentation =
                Arc::new(Mutex::new(initial_turn_presentation(&request)));
            let active_hook_request = Arc::clone(&hook_request);
            let active_turn_request = request.clone();
            let callback_hook_turn = Arc::clone(&hook_turn);
            let callback_lifecycle = Arc::clone(&lifecycle);
            let callback_turn_presentation = Arc::clone(&pending_turn_presentation);
            let active_turn_restore_startup = restore_startup.clone();
            let active_turn_started: CodexActiveTurnCallback =
                Box::new(move |thread_id, turn_id| {
                    if let Some(restore_startup) = active_turn_restore_startup.as_ref() {
                        if !restore_startup.try_activate() {
                            return;
                        }
                        log_executor_event(
                            "runtime restored turn reached active state",
                            &[("local_task_id", active_turn_local_task_id.clone())],
                        );
                    }
                    if !active_turn_handler.is_current_local_task_execution(
                        &active_turn_local_task_id,
                        active_turn_execution_id,
                    ) {
                        return;
                    }
                    crate::task_runtime::mcp::observe_stand_in_turn_boundary(
                        &active_turn_request,
                        Some(&turn_id),
                    );
                    active_turn_handler
                        .start_queue_run(&active_turn_local_task_id, &active_turn_request);
                    *callback_hook_turn
                        .lock()
                        .expect("hook turn context lock should not be poisoned") =
                        Some(ActiveCodexTurn {
                            execution_id: active_turn_execution_id,
                            thread_id: thread_id.clone(),
                            turn_id: turn_id.clone(),
                        });
                    {
                        let mut lifecycle = callback_lifecycle.lock().expect("lifecycle lock");
                        if lifecycle.is_none() {
                            let hook_request =
                                Arc::clone(&active_hook_request.lock().expect("hook request lock"));
                            *lifecycle = active_turn_handler.begin_lifecycle_hooks(
                                &hook_request,
                                &active_turn_local_task_id,
                                "Codex",
                            );
                        }
                        if let Some(hooks) = lifecycle.as_mut() {
                            hooks.started(&thread_id, &turn_id);
                        }
                    }
                    active_turn_handler.record_active_codex_turn(
                        &active_turn_local_task_id,
                        active_turn_execution_id,
                        thread_id.clone(),
                        turn_id.clone(),
                    );
                    active_turn_handler
                        .event_goal_turn_started(&active_turn_local_task_id, &active_turn_request);
                    active_turn_handler.bind_native_turn_start(
                        &active_turn_local_task_id,
                        &active_turn_request,
                        active_turn_execution_id,
                        &thread_id,
                        &turn_id,
                    );
                    let presentation = callback_turn_presentation
                        .lock()
                        .expect("turn presentation lock should not be poisoned")
                        .clone();
                    if owner_input && presentation.is_some() {
                        active_turn_handler
                            .resume_goal_after_owner_input(&active_turn_local_task_id, &thread_id);
                    }
                    active_turn_handler.bind_command_turn(
                        &active_turn_local_task_id,
                        &active_turn_request,
                        active_turn_execution_id,
                        &thread_id,
                        &turn_id,
                    );
                    active_turn_handler.record_runtime_turn_id(
                        &active_turn_local_task_id,
                        presentation
                            .as_ref()
                            .map(|(subtask_id, _)| subtask_id.as_str())
                            .unwrap_or(&turn_id),
                        &turn_id,
                        presentation.as_ref().and_then(|(_, id)| id.as_deref()),
                    );
                    let mut event_request = active_turn_request.clone();
                    event_request.subtask_id = turn_id.clone();
                    if presentation.is_none() {
                        event_request.extra.remove("client_user_message_id");
                        event_request.extra.remove("clientUserMessageId");
                        event_request.extra.remove("runtime_generated_user_message");
                    }
                    active_turn_handler.register_thread_event_route(
                        &thread_id,
                        active_turn_local_task_id.clone(),
                        event_request.clone(),
                        true,
                    );
                    active_turn_handler.emit_task_response(
                        "response.created",
                        &active_turn_local_task_id,
                        &event_request,
                        json!({
                            "response": {
                                "status": "in_progress",
                                "turnId": turn_id,
                            }
                        }),
                    );
                });
            let finished_turn_handler = handler.clone();
            let finished_turn_local_task_id = turn_local_task_id.clone();
            let finished_turn_presentation = Arc::clone(&pending_turn_presentation);
            let finished_turn_request = request.clone();
            let active_turn_finished: CodexActiveTurnFinishedCallback = Box::new(move || {
                crate::task_runtime::mcp::observe_stand_in_turn_boundary(
                    &finished_turn_request,
                    None,
                );
                *finished_turn_presentation
                    .lock()
                    .expect("turn presentation lock should not be poisoned") = None;
                finished_turn_handler
                    .clear_active_codex_turn(&finished_turn_local_task_id, execution_id);
            });
            let recovery_handler = handler.clone();
            let recovery_local_task_id = turn_local_task_id.clone();
            let overload_turn_recovering: CodexActiveTurnCallback = Box::new(move |_, turn_id| {
                recovery_handler.record_overload_recovery_turn(&recovery_local_task_id, &turn_id);
            });
            let mut result = async {
                execution_context?;
                let mut request = request.clone();
                handler.recall_stand_in_context(&mut request).await;
                handler
                    .validate_project_coordinator_request(&request)
                    .await?;
                crate::agents::runtime_capabilities::prepare_codex_runtime(&request).await?;
                let event_goal = handler
                    .event_goal_admission(&turn_local_task_id, &request)
                    .await?;
                if let Some(thread) = direct_thread_id.as_deref().or(resume_thread_id.as_deref()) {
                    handler
                        .append_connection_event_context(&turn_local_task_id, thread, &mut request)
                        .await;
                }
                let resume_goal_only =
                    request.extra.get(RESUME_GOAL_ONLY_MARKER) == Some(&Value::Bool(true));
                let gateway_credentials = handler
                    .model_gateway_credentials(&turn_local_task_id, &mut request, resume_goal_only)
                    .await?;
                handler
                    .codex_app_server
                    .run_turn_with_cancel(
                        request.clone(),
                        CodexAppServerTurnOptions {
                            gateway_credentials,
                            input_admission: handler
                                .automatic_input_admission(&turn_local_task_id, &request),
                            event_goal,
                            recover_usage_limits: true,
                            quota_resume: quota_recovery::wait(&recovery_turn)
                                .map(|wait| wait.recovery),
                            defer_interactive_forms: false,
                            direct_thread_id,
                            fork_thread_id,
                            fork_thread_path,
                            resume_thread_id,
                            resume_goal_only,
                            initial_thread_goal,
                            notifications: Some(notification_tx),
                            cancellation: Some(cancel_rx),
                            request_user_input_answers: Some(request_user_input_rx),
                            thread_started: Some(thread_started),
                            active_turn_started: Some(active_turn_started),
                            active_turn_finished: Some(active_turn_finished),
                            overload_turn_recovering: Some(overload_turn_recovering),
                        },
                    )
                    .await
            }
            .await;
            handler.log_turn_cleanup_stage(&turn_local_task_id, execution_id, "result_received");
            let mapper_result = mapper_handle.await;
            handler.log_turn_cleanup_stage(
                &turn_local_task_id,
                execution_id,
                if mapper_result.is_ok() {
                    "observer_drained"
                } else {
                    "observer_failed"
                },
            );
            if matches!(result.as_ref(),Err(error) if error==crate::agents::AUTOMATIC_INPUT_WAITING_FOR_HUMAN)
            {
                if let Some(startup) = restore_startup.as_ref() {
                    startup.finish();
                }
                match handler
                    .defer_automatic_input(&turn_local_task_id, &request, execution_id)
                    .await
                {
                    Ok(true) => {
                        scheduled_turn_guard.transferred = true;
                        return;
                    }
                    Ok(false) => {}
                    Err(error) => result = Err(error.message),
                }
            }
            if result.is_err() {
                handler.event_goal_admission_failed(&turn_local_task_id, &request);
            }
            let runtime_was_stopped = interrupted_by_runtime_stop(&result);
            scheduled_turn_guard.command_outcome = Some(match result.as_ref() {
                Ok(turn) => command_journal::CommandState::from_execution(&turn.outcome),
                Err(_) if runtime_was_stopped => command_journal::CommandState::RecoveryRequired,
                Err(error) if error == CODEX_APP_SERVER_TURN_CANCELLED => {
                    command_journal::CommandState::Cancelled
                }
                Err(_) => command_journal::CommandState::Failed,
            });
            let goal_execution_needs_attention = match result.as_ref() {
                Err(_) if runtime_was_stopped => false,
                Err(_) => true,
                Ok(turn) => matches!(
                    turn.outcome,
                    ExecutionOutcome::Failed { .. } | ExecutionOutcome::WaitingForUserInput { .. }
                ),
            };
            if let Some(restore_startup) = restore_startup.as_ref() {
                restore_startup.finish();
            }

            if let Some(hooks) = lifecycle.lock().expect("lifecycle lock").as_mut() {
                let status = match &result {
                    Ok(turn) => super::hooks::lifecycle_status(&turn.outcome),
                    Err(error) if error == CODEX_APP_SERVER_TURN_CANCELLED => "interrupted",
                    Err(_) if runtime_was_stopped => "interrupted",
                    Err(_) => "failed",
                };
                hooks.finish(status);
            }
            if let Some(recovery) = result
                .as_mut()
                .ok()
                .and_then(|turn| turn.quota_recovery.take())
            {
                let deferred = match recovery_account {
                    Ok(account) => {
                        handler
                            .defer_quota_turn(recovery_turn, execution_id, recovery, account)
                            .await
                    }
                    Err(error) => Err(AppIpcError::new("quota_recovery_unavailable", error)),
                };
                match deferred {
                    Ok(true) => {
                        scheduled_turn_guard.command_id = None;
                        handler.persist_and_clear_active_codex_transcript(
                            &turn_local_task_id,
                            "completed",
                            hook_turn
                                .lock()
                                .expect("hook turn context poisoned")
                                .as_ref()
                                .map(|turn| turn.turn_id.as_str()),
                        );
                        handler.clear_active_codex_turn(&turn_local_task_id, execution_id);
                        handler.clear_active_request_user_input(&turn_local_task_id, execution_id);
                        handler.mark_thread_event_routes_idle_for_local_task(&turn_local_task_id);
                        return;
                    }
                    Ok(false) => {
                        result = Err("Quota recovery cancelled by newer task activity".to_owned())
                    }
                    Err(error) => result = Err(error.message),
                }
                scheduled_turn_guard.command_outcome = Some(command_journal::CommandState::Failed);
            }
            if !handler.is_current_local_task_execution(&turn_local_task_id, execution_id) {
                log_executor_event(
                    "runtime work stale execution result ignored",
                    &[
                        ("local_task_id", turn_local_task_id.clone()),
                        ("execution_id", execution_id.to_string()),
                    ],
                );
                handler.clear_active_codex_turn(&turn_local_task_id, execution_id);
                handler.clear_active_request_user_input(&turn_local_task_id, execution_id);
                return;
            }

            if matches!(result.as_ref(), Err(error) if error == CODEX_APP_SERVER_TURN_CANCELLED) {
                let active_turn = hook_turn
                    .lock()
                    .expect("hook turn context lock should not be poisoned")
                    .clone();
                let event_request = handler.request_for_codex_event(
                    &turn_local_task_id,
                    &request,
                    active_turn.as_ref().map(|turn| turn.turn_id.as_str()),
                );
                handler.persist_and_clear_active_codex_transcript(
                    &turn_local_task_id,
                    "cancelled",
                    active_turn.as_ref().map(|turn| turn.turn_id.as_str()),
                );
                if handler.settle_cancelled_local_task_execution(&turn_local_task_id, execution_id)
                {
                    handler.finish_automation_run(
                        &turn_local_task_id,
                        &event_request,
                        AutomationRunStatus::Cancelled,
                        Some("cancelled".to_owned()),
                    );
                    handler.finish_queue_run(
                        &turn_local_task_id,
                        &event_request,
                        AutomationRunStatus::Cancelled,
                        Some("cancelled".to_owned()),
                        None,
                    );
                    handler.emit_task_response(
                        "response.incomplete",
                        &turn_local_task_id,
                        &event_request,
                        json!({
                            "type": "cancelled",
                            "error": {"message": "cancelled"},
                        }),
                    );
                }
                handler.clear_active_codex_turn(&turn_local_task_id, execution_id);
                handler.mark_thread_event_routes_idle_for_local_task(&turn_local_task_id);
                handler.clear_active_request_user_input(&turn_local_task_id, execution_id);
                handler.clear_active_goal_turn(&turn_local_task_id);
                return;
            }

            let transcript_status = match result.as_ref() {
                Ok(turn) => match turn.outcome {
                    ExecutionOutcome::Completed { .. }
                    | ExecutionOutcome::WaitingForUserInput { .. } => "completed",
                    ExecutionOutcome::Cancelled { .. } => "cancelled",
                    ExecutionOutcome::Failed { .. } => "failed",
                    ExecutionOutcome::Running => "inProgress",
                },
                Err(_) if interrupted_by_runtime_stop(&result) => "inProgress",
                Err(_) => "failed",
            };
            let active_turn = hook_turn
                .lock()
                .expect("hook turn context lock should not be poisoned")
                .clone();
            handler.persist_and_clear_active_codex_transcript(
                &turn_local_task_id,
                transcript_status,
                active_turn.as_ref().map(|turn| turn.turn_id.as_str()),
            );
            handler.handle_turn_result(
                &turn_local_task_id,
                execution_id,
                &request,
                active_turn.as_ref(),
                result,
            );
            handler.log_turn_cleanup_stage(
                &turn_local_task_id,
                execution_id,
                "local_result_settled",
            );
            handler.clear_active_codex_turn(&turn_local_task_id, execution_id);
            handler.clear_active_request_user_input(&turn_local_task_id, execution_id);
            if runtime_was_stopped {
                return;
            }
            handler
                .settle_native_request_journal(&turn_local_task_id, goal_execution_needs_attention);
        });
        drop(turn_handle);
    }

    pub(super) fn is_queued_local_task(&self, local_task_id: &str) -> bool {
        self.queued_local_task_position(local_task_id).is_some()
    }

    pub(super) fn queued_local_task_position(&self, local_task_id: &str) -> Option<usize> {
        self.turn_scheduler
            .lock()
            .expect("runtime turn scheduler lock should not be poisoned")
            .queued_position(local_task_id)
    }

    pub(super) fn is_busy_local_task(&self, local_task_id: &str) -> bool {
        self.is_active_local_task(local_task_id)
            || self.native_task_holds_capacity(local_task_id)
            || self.is_queued_local_task(local_task_id)
            || self
                .preparing_turns
                .lock()
                .expect("preparation map poisoned")
                .contains_key(local_task_id)
    }

    pub(super) async fn remove_queued_turn(
        &self,
        local_task_id: &str,
    ) -> Result<bool, AppIpcError> {
        self.remove_queued_turn_for_command(local_task_id, None)
            .await
    }

    pub(super) async fn remove_queued_turn_for_command(
        &self,
        local_task_id: &str,
        command_id: Option<&str>,
    ) -> Result<bool, AppIpcError> {
        let _operation = self.turn_queue_operation.lock().await;
        // Cancellation and queue-to-preparation admission share this transaction.
        // A checking turn must not repark after cancellation found no queued turn.
        if command_id.is_none() && self.cancel_preparing_turn(local_task_id) {
            self.request_active_turn_stop(local_task_id);
        }
        let (previous, remaining_turns) = {
            let mut scheduler = self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned");
            let Some(position) = scheduler.queued_turns.iter().position(|turn| {
                turn.local_task_id == local_task_id
                    && command_id.map_or(true, |id| {
                        turn.request
                            .extra
                            .get("runtime_command_id")
                            .and_then(Value::as_str)
                            == Some(id)
                    })
            }) else {
                return Ok(false);
            };
            let previous = scheduler.clone();
            scheduler.queued_turns.remove(position);
            (previous, scheduler.queued_turns.clone())
        };
        if let Err(error) = self
            .persist_turn_queue(remaining_turns, Some(&previous), &[])
            .await
        {
            *self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned") = previous;
            return Err(error);
        }
        Ok(true)
    }

    pub(super) async fn finish_scheduled_turn(&self, local_task_id: &str) {
        let operation = self.turn_queue_operation.clone().lock_owned().await;
        self.finish_scheduled_turn_locked(local_task_id, operation)
            .await;
    }

    pub(super) async fn finish_scheduled_turn_locked(
        &self,
        local_task_id: &str,
        _operation: tokio::sync::OwnedMutexGuard<()>,
    ) {
        // A native Goal can outlive the local request that admitted it. Its
        // task keeps the reservation until native execution actually settles.
        if self.native_task_holds_capacity(local_task_id) {
            return;
        }
        let (previous, turns, remaining_turns) = {
            let mut scheduler = self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned");
            let previous = scheduler.clone();
            scheduler.refresh_automatic_waits(&self.store, None);
            let turns = scheduler.finish(local_task_id);
            let remaining_turns = scheduler.queued_turns.clone();
            (previous, turns, remaining_turns)
        };
        if let Err(error) = self
            .persist_turn_queue(remaining_turns, Some(&previous), &turns)
            .await
        {
            let mut scheduler = self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned");
            *scheduler = previous;
            scheduler.active_task_ids.remove(local_task_id);
            log_executor_event(
                "runtime turn queue drain persistence failed",
                &[("error", error.message)],
            );
            return;
        }
        for turn in &turns {
            self.reserve_turn_preparation(turn);
        }
        drop(_operation);
        for turn in turns {
            self.start_queued_turn(turn);
        }
    }

    pub(super) async fn update_concurrency_settings(&self, settings: RuntimeSettings) {
        let _operation = self.turn_queue_operation.lock().await;
        let (previous, turns, remaining_turns) = {
            let mut scheduler = self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned");
            let previous = scheduler.clone();
            scheduler.refresh_automatic_waits(&self.store, None);
            let turns = scheduler.update_limits(settings.clone());
            let remaining_turns = (!turns.is_empty()).then(|| scheduler.queued_turns.clone());
            (previous, turns, remaining_turns)
        };
        if let Some(remaining_turns) = remaining_turns {
            if let Err(error) = self
                .persist_turn_queue(remaining_turns, Some(&previous), &turns)
                .await
            {
                let mut scheduler = self
                    .turn_scheduler
                    .lock()
                    .expect("runtime turn scheduler lock should not be poisoned");
                *scheduler = previous;
                scheduler.settings = settings;
                log_executor_event(
                    "runtime turn queue limit persistence failed",
                    &[("error", error.message)],
                );
                return;
            }
        }
        for turn in &turns {
            self.reserve_turn_preparation(turn);
        }
        drop(_operation);
        for turn in turns {
            self.start_queued_turn(turn);
        }
    }

    pub(super) async fn resume_persisted_turns(&self) {
        self.ensure_quota_waker();
        let _operation = self.turn_queue_operation.lock().await;
        let (previous, turns, remaining_turns) = {
            let mut scheduler = self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned");
            let previous = scheduler.clone();
            scheduler.refresh_automatic_waits(&self.store, None);
            let turns = scheduler.take_available();
            if turns.is_empty() {
                return;
            }
            (previous, turns, scheduler.queued_turns.clone())
        };
        if let Err(error) = self
            .persist_turn_queue(remaining_turns, Some(&previous), &turns)
            .await
        {
            *self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned") = previous;
            log_executor_event(
                "runtime turn queue drain persistence failed",
                &[("error", error.message)],
            );
            return;
        }
        for turn in &turns {
            self.reserve_turn_preparation(turn);
        }
        drop(_operation);
        for turn in turns {
            self.start_queued_turn(turn);
        }
    }

    pub(super) fn handle_turn_result(
        &self,
        local_task_id: &str,
        execution_id: u64,
        request: &ExecutionRequest,
        active_turn: Option<&ActiveCodexTurn>,
        result: Result<crate::agents::CodexAppServerTurn, String>,
    ) {
        if interrupted_by_runtime_stop(&result) {
            log_executor_event(
                "runtime work turn interrupted by runtime stop",
                &[
                    ("local_task_id", local_task_id.to_owned()),
                    ("execution_id", execution_id.to_string()),
                ],
            );
            return;
        }
        let event_request = self.request_for_codex_event(
            local_task_id,
            request,
            active_turn.map(|turn| turn.turn_id.as_str()),
        );
        let automation_result = match &result {
            Ok(turn) => match &turn.outcome {
                ExecutionOutcome::Completed { .. } => Some((AutomationRunStatus::Succeeded, None)),
                ExecutionOutcome::WaitingForUserInput { stop_reason } => Some((
                    AutomationRunStatus::NeedsAttention,
                    Some(stop_reason.clone()),
                )),
                ExecutionOutcome::Cancelled { message } => {
                    Some((AutomationRunStatus::Cancelled, Some(message.clone())))
                }
                ExecutionOutcome::Failed { message } => {
                    Some((AutomationRunStatus::Failed, Some(message.clone())))
                }
                ExecutionOutcome::Running => None,
            },
            Err(error) => Some((AutomationRunStatus::Failed, Some(error.clone()))),
        };
        let queue_result_content = match &result {
            Ok(turn) => match &turn.outcome {
                ExecutionOutcome::Completed { content } => Some(content.clone()),
                ExecutionOutcome::WaitingForUserInput { .. } => Some(String::new()),
                ExecutionOutcome::Cancelled { .. }
                | ExecutionOutcome::Failed { .. }
                | ExecutionOutcome::Running => None,
            },
            Err(_) => None,
        };
        self.record_project_router_assessment(
            request,
            result
                .as_ref()
                .map(|turn| &turn.outcome)
                .map_err(String::as_str),
        );
        match result {
            Ok(turn) => {
                let status = match &turn.outcome {
                    ExecutionOutcome::Completed { .. } => "done",
                    ExecutionOutcome::WaitingForUserInput { .. } => "done",
                    ExecutionOutcome::Cancelled { .. } => "cancelled",
                    ExecutionOutcome::Failed { .. } => "failed",
                    ExecutionOutcome::Running => return,
                };
                let thread_id = turn.thread_id.clone();
                if !self.finish_local_task(
                    local_task_id,
                    execution_id,
                    Some(thread_id.clone()),
                    status,
                ) {
                    log_executor_event(
                        "runtime work terminal result ignored for stale execution",
                        &[
                            ("local_task_id", local_task_id.to_owned()),
                            ("execution_id", execution_id.to_string()),
                            ("status", status.to_owned()),
                        ],
                    );
                    return;
                }
                if turn.goal_status_observed {
                    self.observe_runtime_task_goal_status(local_task_id, turn.goal_status.clone());
                }
                self.register_thread_event_route(
                    &thread_id,
                    local_task_id.to_owned(),
                    event_request.clone(),
                    false,
                );
                self.mark_thread_event_route_idle(&thread_id);
                self.register_codex_thread_workspace_root(&thread_id, &event_request, false);
                let response_item_id = turn.response_item_id;
                let response_value_origin = turn.response_value_origin;
                if response_value_origin == crate::agents::CodexResponseValueOrigin::Final
                    && matches!(&turn.outcome, ExecutionOutcome::Completed {content} if !content.trim().is_empty())
                {
                    self.record_identity_completion(
                        local_task_id,
                        request,
                        active_turn,
                        response_item_id.as_deref(),
                        turn.completed_at_ms,
                    );
                }
                match turn.outcome {
                    ExecutionOutcome::Completed { .. }
                    | ExecutionOutcome::Cancelled { .. }
                    | ExecutionOutcome::Failed { .. }
                        if self.local_task_link(local_task_id).is_some_and(|link| {
                            crate::runtime_work::lifecycle::native_execution_state(&link)
                                .is_some_and(|state| state.request_turn_id.is_some())
                        }) => {}
                    ExecutionOutcome::Completed { content } => self.emit_task_response(
                        "response.completed",
                        local_task_id,
                        &event_request,
                        json!({
                            "value": content,
                            "valueOrigin": response_value_origin.as_str(),
                            "turnId": active_turn.map(|turn| &turn.turn_id),
                            "itemId": response_item_id,
                            "startedAt": turn.started_at_ms,
                            "completedAt": turn.completed_at_ms,
                            "durationMs": turn.duration_ms,
                        }),
                    ),
                    ExecutionOutcome::WaitingForUserInput { stop_reason } => self
                        .emit_task_response(
                            "response.completed",
                            local_task_id,
                            &event_request,
                            json!({
                                "value": "",
                                "valueOrigin": "empty",
                                "turnId": active_turn.map(|turn| &turn.turn_id),
                                "startedAt": turn.started_at_ms,
                                "completedAt": turn.completed_at_ms,
                                "durationMs": turn.duration_ms,
                                "stop_reason": stop_reason,
                                "silent_exit": true,
                                "silent_exit_reason": "waiting_for_user_input"
                            }),
                        ),
                    ExecutionOutcome::Cancelled { message } => self.emit_task_response(
                        "response.incomplete",
                        local_task_id,
                        &event_request,
                        json!({
                            "error": {"message": message},
                            "startedAt": turn.started_at_ms,
                            "completedAt": turn.completed_at_ms,
                            "durationMs": turn.duration_ms,
                        }),
                    ),
                    ExecutionOutcome::Failed { message } => {
                        let failure_info = error_info(turn.error_type.as_deref(), Some(&message));
                        self.persist_failed_assistant_message_with_info(
                            local_task_id,
                            &event_request,
                            &message,
                            failure_info.clone(),
                            false,
                        );
                        let mut fields =
                            task_fields(&event_request.task_id, &event_request.subtask_id);
                        fields.push(("local_task_id", local_task_id.to_owned()));
                        fields.push(("error", message.clone()));
                        fields.push(("error_len", message.len().to_string()));
                        log_executor_event("runtime work turn failed", &fields);
                        self.emit_task_response(
                            "response.failed",
                            local_task_id,
                            &event_request,
                            json!({
                                "error": {"message": message, "code": failure_info["code"]},
                                "error_info": failure_info,
                                "type": failure_info["code"],
                                "startedAt": turn.started_at_ms,
                                "completedAt": turn.completed_at_ms,
                                "durationMs": turn.duration_ms,
                            }),
                        );
                    }
                    ExecutionOutcome::Running => {}
                }
            }
            Err(error) => {
                if !self.finish_local_task(local_task_id, execution_id, None, "failed") {
                    log_executor_event(
                        "runtime work failed result ignored for stale execution",
                        &[
                            ("local_task_id", local_task_id.to_owned()),
                            ("execution_id", execution_id.to_string()),
                        ],
                    );
                    return;
                }
                self.mark_thread_event_routes_idle_for_local_task(local_task_id);
                let failure_info = error_info(None, Some(&error));
                self.persist_failed_assistant_message(local_task_id, &event_request, &error);
                let mut fields = task_fields(&event_request.task_id, &event_request.subtask_id);
                fields.push(("local_task_id", local_task_id.to_owned()));
                fields.push(("error", error.clone()));
                fields.push(("error_len", error.len().to_string()));
                log_executor_event("runtime work turn failed", &fields);
                self.emit_task_response(
                    "response.failed",
                    local_task_id,
                    &event_request,
                    json!({
                        "error": {"message": error, "code": failure_info["code"]},
                        "error_info": failure_info,
                    }),
                );
            }
        }
        if let Some((status, error)) = automation_result {
            self.finish_automation_run(local_task_id, &event_request, status, error.clone());
            self.finish_queue_run(
                local_task_id,
                &event_request,
                status,
                error,
                queue_result_content,
            );
        }
    }

    pub(super) fn persist_failed_assistant_message(
        &self,
        local_task_id: &str,
        request: &ExecutionRequest,
        error: &str,
    ) {
        self.persist_failed_assistant_message_with_info(
            local_task_id,
            request,
            error,
            error_info(None, Some(error)),
            true,
        );
    }

    fn persist_failed_assistant_message_with_info(
        &self,
        local_task_id: &str,
        request: &ExecutionRequest,
        error: &str,
        failure_info: Value,
        preparation: bool,
    ) {
        let timestamp = if preparation {
            self.store
                .read_task(local_task_id, |link| link.completed_at)
                .flatten()
                .unwrap_or_else(now_ms)
        } else {
            now_ms()
        };
        self.persist_failed_assistant_message_with_timestamp(
            local_task_id,
            request,
            error,
            failure_info,
            preparation,
            timestamp,
        );
    }

    fn persist_failed_assistant_message_with_timestamp(
        &self,
        local_task_id: &str,
        request: &ExecutionRequest,
        error: &str,
        failure_info: Value,
        preparation: bool,
        timestamp: i64,
    ) {
        let message = json!({
            "id": format!("{local_task_id}:assistant:{}", request.subtask_id),
            "role": "assistant",
            "content": "",
            "status": "failed",
            "error": error,
            "errorType": "response.failed",
            "errorCode": failure_info["code"],
            "errorInfo": failure_info,
            "subtaskId": request.subtask_id,
            "createdAt": timestamp,
            "completedAt": timestamp,
        });
        self.store.update_task(local_task_id, |link| {
            if preparation {
                let diagnostic = link.runtime_handle["startupFailure"].clone();
                let startup_error = AppIpcError::new("runtime_start_failed", error);
                apply_local_task_failure_at(link, &startup_error, timestamp);
                link.runtime_handle["startupFailure"] = diagnostic;
                record_preparation_failure(
                    link,
                    request,
                    &startup_error,
                    &message["errorInfo"],
                    timestamp,
                );
            }
            if link.thread_id.is_some() {
                return;
            }
            append_runtime_handle_message(&mut link.runtime_handle, message.clone());
            link.updated_at = timestamp;
        });
    }

    pub(super) fn apply_project_workspace_roots(&self, request: &mut ExecutionRequest) {
        if !request.runtime_workspace_roots.is_empty() {
            return;
        }
        let Some(cwd) = request.cwd() else {
            return;
        };
        let project_index = CodexGlobalProjectIndex::load();
        let Some(project) = project_index.project_for_path(cwd) else {
            return;
        };
        request.runtime_workspace_roots = project.roots.clone();
    }

    pub(super) fn register_codex_thread_workspace_root(
        &self,
        thread_id: &str,
        request: &ExecutionRequest,
        is_new_thread: bool,
    ) {
        let Some(workspace_path) = request.cwd() else {
            return;
        };
        if infer_workspace_kind(workspace_path) != "chat" {
            match register_codex_global_thread_workspace_root(
                thread_id,
                workspace_path,
                request.runtime_project_key.as_deref(),
                is_new_thread,
            ) {
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
        // The rollout observer needs every thread it started, including
        // standalone chats, because subagent rollouts are matched to it.
        if let Err(error) = self.hook_service.rollout.register_root(
            thread_id,
            hook_user(request),
            PathBuf::from(workspace_path),
            super::hooks::hook_model_identity(request).0,
        ) {
            log_executor_event(
                "runtime work codex rollout thread registration failed",
                &[("thread_id", thread_id.to_owned()), ("error", error)],
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_personal_identity_respects_the_stored_task_scope() {
        let request = ExecutionRequest::default();
        assert!(personal_runtime_scope(&request, &json!({})));
        for handle in [
            json!({"origin": {"type": "connection_work"}}),
            json!({"executionRequest": {"origin": {"type": "issue_dispatch"}}}),
            json!({"executionRequest": {"standInDelegation": {}}}),
            json!({"cloudProjectId": "shared"}),
            json!({"wegentTeam": {"id": 42}}),
        ] {
            assert!(!personal_runtime_scope(&request, &handle));
        }
    }

    #[test]
    fn recovered_goal_does_not_rebind_persisted_user_message() {
        let mut request = ExecutionRequest {
            subtask_id: "submitted-subtask".to_owned(),
            extra: serde_json::from_value(json!({
                "client_user_message_id": "original-user",
                "clientUserMessageId": "original-user",
                "runtime_generated_user_message": true,
            }))
            .unwrap(),
            ..ExecutionRequest::default()
        };
        assert_eq!(
            initial_turn_presentation(&request),
            Some((
                "submitted-subtask".to_owned(),
                Some("original-user".to_owned())
            ))
        );
        let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
        let normal = handler.request_for_codex_event("missing-task", &request, None);
        assert_eq!(normal.extra, request.extra);
        request
            .extra
            .insert(RESUME_GOAL_ONLY_MARKER.to_owned(), json!(true));
        assert_eq!(initial_turn_presentation(&request), None);

        for turn_id in [None, Some("recovered-turn")] {
            let recovered = handler.request_for_codex_event("missing-task", &request, turn_id);
            assert_eq!(recovered.subtask_id, turn_id.unwrap_or("submitted-subtask"));
            for key in [
                "client_user_message_id",
                "clientUserMessageId",
                "runtime_generated_user_message",
            ] {
                assert!(
                    !recovered.extra.contains_key(key),
                    "Recovered turn retained {key}"
                );
            }
        }
        assert_eq!(request.extra["client_user_message_id"], "original-user");
    }

    fn scheduled_turn(local_task_id: &str) -> SpawnTurnRequest {
        SpawnTurnRequest {
            task_kind: None,
            local_task_id: local_task_id.to_owned(),
            runtime: "codex".to_owned(),
            request: ExecutionRequest::default(),
            send_payload: None,
            direct_thread_id: None,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: None,
            initial_thread_goal: None,
        }
    }

    #[tokio::test]
    async fn restore_startup_timeout_prevents_late_activation() {
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = Arc::clone(&semaphore)
            .acquire_owned()
            .await
            .expect("restore startup permit should be available");
        let startup = RestoreStartupGate::new(permit);

        assert_eq!(semaphore.available_permits(), 0);
        assert!(startup.try_timeout());
        assert_eq!(semaphore.available_permits(), 1);
        assert!(!startup.try_activate());
    }

    #[tokio::test]
    async fn restore_startup_activation_prevents_late_timeout() {
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = Arc::clone(&semaphore)
            .acquire_owned()
            .await
            .expect("restore startup permit should be available");
        let startup = RestoreStartupGate::new(permit);

        assert_eq!(semaphore.available_permits(), 0);
        assert!(startup.try_activate());
        assert_eq!(semaphore.available_permits(), 1);
        assert!(!startup.try_timeout());
    }

    #[tokio::test]
    async fn restore_startup_allows_overload_continuation_until_execution_finishes() {
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = Arc::clone(&semaphore).acquire_owned().await.unwrap();
        let startup = RestoreStartupGate::new(permit);

        assert!(startup.try_activate());
        assert!(startup.try_activate());
        assert_eq!(semaphore.available_permits(), 1);
        assert!(!startup.try_timeout());
        startup.finish();
        assert!(!startup.try_activate());
        assert!(!startup.try_timeout());
    }

    #[test]
    fn scheduler_queues_over_limit_and_starts_in_fifo_order() {
        let mut scheduler = RuntimeTurnScheduler::new(RuntimeSettings::uniform(2), VecDeque::new());

        assert_eq!(
            scheduler
                .enqueue(scheduled_turn("task-1"))
                .map(|turn| turn.local_task_id),
            Some("task-1".to_owned())
        );
        assert_eq!(
            scheduler
                .enqueue(scheduled_turn("task-2"))
                .map(|turn| turn.local_task_id),
            Some("task-2".to_owned())
        );
        assert!(scheduler.enqueue(scheduled_turn("task-3")).is_none());
        assert!(scheduler.enqueue(scheduled_turn("task-4")).is_none());

        assert_eq!(
            scheduler
                .finish("task-1")
                .into_iter()
                .map(|turn| turn.local_task_id)
                .collect::<Vec<_>>(),
            vec!["task-3"]
        );
        assert_eq!(
            scheduler
                .finish("task-2")
                .into_iter()
                .map(|turn| turn.local_task_id)
                .collect::<Vec<_>>(),
            vec!["task-4"]
        );
        assert_eq!(scheduler.active_task_ids.len(), 2);
        assert!(scheduler.queued_turns.is_empty());
    }

    #[test]
    fn scheduler_serializes_turns_for_the_same_task() {
        let mut scheduler = RuntimeTurnScheduler::new(RuntimeSettings::uniform(2), VecDeque::new());

        assert!(scheduler.enqueue(scheduled_turn("task-1")).is_some());
        assert!(scheduler.enqueue(scheduled_turn("task-1")).is_none());
        assert_eq!(scheduler.queued_turns.len(), 1);
        assert_eq!(scheduler.active_task_ids.len(), 1);

        let started = scheduler.finish("task-1");

        assert_eq!(started.len(), 1);
        assert_eq!(started[0].local_task_id, "task-1");
        assert_eq!(scheduler.active_task_ids.len(), 1);
        assert!(scheduler.queued_turns.is_empty());
    }

    #[test]
    fn scheduler_skips_queued_turns_for_tasks_that_are_still_active() {
        let mut scheduler = RuntimeTurnScheduler::new(RuntimeSettings::uniform(2), VecDeque::new());
        assert!(scheduler.enqueue(scheduled_turn("task-1")).is_some());
        assert!(scheduler.enqueue(scheduled_turn("task-2")).is_some());
        scheduler.enqueue_queued(scheduled_turn("task-1"));
        scheduler.enqueue_queued(scheduled_turn("task-3"));

        let started = scheduler.finish("task-2");

        assert_eq!(started.len(), 1);
        assert_eq!(started[0].local_task_id, "task-3");
        assert_eq!(scheduler.queued_turns.len(), 1);
        assert_eq!(scheduler.queued_turns[0].local_task_id, "task-1");
        assert!(scheduler.active_task_ids.contains_key("task-1"));
        assert!(scheduler.active_task_ids.contains_key("task-3"));
    }

    #[test]
    fn forced_turn_overcommits_without_releasing_more_queued_work() {
        let mut scheduler = RuntimeTurnScheduler::new(RuntimeSettings::uniform(1), VecDeque::new());
        assert!(scheduler.enqueue(scheduled_turn("running")).is_some());
        assert!(scheduler.enqueue(scheduled_turn("forced")).is_none());
        assert!(scheduler.enqueue(scheduled_turn("waiting")).is_none());

        assert_eq!(
            scheduler
                .force_start("forced")
                .map(|turn| turn.local_task_id),
            Some("forced".to_owned())
        );
        assert_eq!(scheduler.active_task_ids.len(), 2);
        assert!(scheduler.finish("running").is_empty());
        assert_eq!(scheduler.active_task_ids.len(), 1);
        assert_eq!(
            scheduler
                .finish("forced")
                .into_iter()
                .map(|turn| turn.local_task_id)
                .collect::<Vec<_>>(),
            vec!["waiting"]
        );
        assert_eq!(scheduler.active_task_ids.len(), 1);
    }

    #[test]
    fn forced_enqueue_starts_new_work_without_disturbing_the_existing_queue() {
        let mut scheduler = RuntimeTurnScheduler::new(RuntimeSettings::uniform(1), VecDeque::new());
        assert!(scheduler.enqueue(scheduled_turn("running")).is_some());
        assert!(scheduler.enqueue(scheduled_turn("waiting")).is_none());

        assert_eq!(
            scheduler
                .enqueue_forced(scheduled_turn("forced"))
                .local_task_id,
            "forced"
        );
        assert_eq!(scheduler.active_task_ids.len(), 2);
        assert_eq!(
            scheduler
                .queued_turns
                .iter()
                .map(|turn| turn.local_task_id.as_str())
                .collect::<Vec<_>>(),
            vec!["waiting"]
        );
    }

    #[test]
    fn increasing_limit_starts_queued_turns_immediately() {
        let mut scheduler = RuntimeTurnScheduler::new(RuntimeSettings::uniform(1), VecDeque::new());
        assert!(scheduler.enqueue(scheduled_turn("task-1")).is_some());
        assert!(scheduler.enqueue(scheduled_turn("task-2")).is_none());
        assert!(scheduler.enqueue(scheduled_turn("task-3")).is_none());

        let started = scheduler
            .update_limits(RuntimeSettings::uniform(3))
            .into_iter()
            .map(|turn| turn.local_task_id)
            .collect::<Vec<_>>();

        assert_eq!(started, vec!["task-2", "task-3"]);
        assert_eq!(scheduler.active_task_ids.len(), 3);
        assert!(scheduler.queued_turns.is_empty());
    }

    #[test]
    fn scheduler_reorders_the_real_fifo_queue() {
        let scheduler = RuntimeTurnScheduler::new(
            RuntimeSettings::uniform(1),
            VecDeque::from([
                scheduled_turn("task-1"),
                scheduled_turn("task-2"),
                scheduled_turn("task-3"),
            ]),
        );

        let reordered = scheduler
            .reordered_queue("task-3", 1)
            .expect("queued task should be reorderable");

        assert_eq!(
            reordered
                .iter()
                .map(|turn| turn.local_task_id.as_str())
                .collect::<Vec<_>>(),
            vec!["task-3", "task-1", "task-2"]
        );
        assert_eq!(
            scheduler
                .queued_turns
                .iter()
                .map(|turn| turn.local_task_id.as_str())
                .collect::<Vec<_>>(),
            vec!["task-1", "task-2", "task-3"]
        );
    }

    #[test]
    fn persisted_queue_round_trips_without_plaintext_credentials() {
        let temp = tempfile::tempdir().expect("temporary queue directory should exist");
        let queue_path = temp.path().join("turn-queue.json");
        let mut turn = scheduled_turn("task-secret");
        turn.runtime = "claude_code".to_owned();
        turn.request.auth_token = Some("top-secret-auth-token".to_owned());
        turn.request.runtime_auth_token = Some("runtime-secret-token".to_owned());
        turn.request.model_config = json!({"api_key": "model-secret-key"});
        turn.request.extra.insert(
            "deferred_worktree_repo_root_fingerprint".to_owned(),
            Value::String("sha256:planned-repository".to_owned()),
        );
        let turns = VecDeque::from([turn]);

        write_runtime_turn_queue(&queue_path, &turns).expect("runtime queue should be persisted");
        let disk = fs::read_to_string(&queue_path).expect("runtime queue file should be readable");
        assert!(!disk.contains("top-secret-auth-token"));
        assert!(!disk.contains("runtime-secret-token"));
        assert!(!disk.contains("model-secret-key"));

        let restored =
            read_runtime_turn_queue(&queue_path).expect("runtime queue should be restored");
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].runtime, "claude_code");
        assert_eq!(
            restored[0].request.auth_token.as_deref(),
            Some("top-secret-auth-token")
        );
        assert_eq!(
            restored[0].request.runtime_auth_token.as_deref(),
            Some("runtime-secret-token")
        );
        assert_eq!(
            restored[0].request.model_config["api_key"],
            "model-secret-key"
        );
        assert_eq!(
            restored[0].request.extra["deferred_worktree_repo_root_fingerprint"],
            "sha256:planned-repository"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let queue_mode = fs::metadata(&queue_path)
                .expect("runtime queue metadata should be readable")
                .permissions()
                .mode()
                & 0o777;
            let key_mode = fs::metadata(runtime_turn_queue_key_path(&queue_path))
                .expect("runtime queue key metadata should be readable")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(queue_mode, 0o600);
            assert_eq!(key_mode, 0o600);
        }
    }

    #[test]
    fn accepted_command_and_waiting_queue_share_one_encrypted_commit() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("turn-queue.json");
        let mut turn = scheduled_turn("task-command");
        turn.request.prompt = json!("durable input");
        turn.request.extra.insert("user_id".into(), json!(7));
        turn.request.auth_token = Some("command-secret".into());
        apply_runtime_payload_metadata(
            &mut turn.request,
            &json!({"commandId":"stable-command","message":"durable input"}),
        );
        let command = command_journal::RuntimeCommand::from_turn(
            &turn,
            command_journal::CommandState::Dispatching,
        )
        .unwrap()
        .unwrap();
        let journal = std::collections::BTreeMap::from([(command.key(), command)]);
        write_runtime_turn_state(&path, &VecDeque::new(), &HashMap::new(), &journal).unwrap();
        let restored = read_runtime_turn_state(&path).unwrap();
        let command = restored.commands.values().next().unwrap();
        assert_eq!(command.state, command_journal::CommandState::Dispatching);
        assert_eq!(command.turn.request.prompt, json!("durable input"));
        assert_eq!(
            command.turn.request.auth_token.as_deref(),
            Some("command-secret")
        );
        let disk = fs::read_to_string(&path).unwrap();
        assert!(!disk.contains("durable input"));
        assert!(!disk.contains("command-secret"));
        assert!(restored.queued_turns.is_empty());
    }

    #[test]
    fn persisted_queue_retains_active_goal_turns_separately_from_waiting_turns() {
        let temp = tempfile::tempdir().expect("temporary queue directory should exist");
        let queue_path = temp.path().join("turn-queue.json");
        let queued = VecDeque::from([scheduled_turn("task-queued")]);
        let active_goal_turns =
            HashMap::from([("task-goal".to_owned(), scheduled_turn("task-goal"))]);

        write_runtime_turn_state(
            &queue_path,
            &queued,
            &active_goal_turns,
            &Default::default(),
        )
        .expect("runtime queue state should be persisted");

        let restored =
            read_runtime_turn_state(&queue_path).expect("runtime queue state should be restored");
        assert_eq!(restored.queued_turns.len(), 1);
        assert_eq!(restored.queued_turns[0].local_task_id, "task-queued");
        assert_eq!(restored.active_goal_turns.len(), 1);
        assert_eq!(
            restored.active_goal_turns["task-goal"].local_task_id,
            "task-goal"
        );
    }

    #[test]
    fn concurrent_queue_writes_use_one_key_and_unique_temporary_files() {
        let temp = tempfile::tempdir().expect("temporary queue directory should exist");
        let queue_path = Arc::new(temp.path().join("turn-queue.json"));
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let writers = (0..8)
            .map(|index| {
                let queue_path = Arc::clone(&queue_path);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let turns =
                        VecDeque::from([scheduled_turn(&format!("task-concurrent-{index}"))]);
                    barrier.wait();
                    write_runtime_turn_queue(&queue_path, &turns)
                })
            })
            .collect::<Vec<_>>();

        for writer in writers {
            writer
                .join()
                .expect("queue writer should not panic")
                .expect("concurrent queue write should succeed");
        }

        let restored =
            read_runtime_turn_queue(&queue_path).expect("final queue should remain decryptable");
        assert_eq!(restored.len(), 1);
        assert!(restored[0].local_task_id.starts_with("task-concurrent-"));
        let temporary_files = fs::read_dir(temp.path())
            .expect("queue directory should remain readable")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.ends_with(".tmp"))
            })
            .count();
        assert_eq!(temporary_files, 0);
    }

    #[test]
    fn restored_worktree_turns_are_removed_from_resumable_queue() {
        let temp = tempfile::tempdir().expect("temporary worktree directory should exist");
        let worktrees = WorktreeManager::new(temp.path().join("runtime-work/worktrees.json"));
        let managed_root = temp.path().join("workspace/worktrees");
        worktrees
            .update_settings(WorktreeSettingsPatch {
                worktree_root: Some(managed_root.display().to_string()),
                ..WorktreeSettingsPatch::default()
            })
            .expect("managed worktree root should be configured");

        let normal = scheduled_turn("normal");
        let mut deferred = scheduled_turn("deferred-worktree");
        deferred.request.extra.insert(
            "deferred_worktree_source_path".to_owned(),
            Value::String(temp.path().join("source").display().to_string()),
        );
        let mut existing = scheduled_turn("existing-worktree");
        existing.request.project_workspace_path = Some(
            managed_root
                .join("existing-worktree/repository")
                .display()
                .to_string(),
        );

        let mut restored = VecDeque::from([normal, deferred, existing]);
        let removed = remove_worktree_turns_after_restart(&worktrees, &mut restored);

        assert_eq!(
            restored
                .iter()
                .map(|turn| turn.local_task_id.as_str())
                .collect::<Vec<_>>(),
            vec!["normal"]
        );
        assert_eq!(removed, 2);
    }

    #[test]
    fn resolves_anonymous_hook_user_without_private_config_fallbacks() {
        assert_eq!(
            hook_user(&ExecutionRequest::default()),
            HookUser {
                id: None,
                name: "anonymous".to_owned(),
            }
        );
    }
}

#[cfg(test)]
#[path = "preparation_terminal_tests.rs"]
mod preparation_terminal_tests;
