// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::fs::OpenOptions;
use std::io::Write;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const RUNTIME_TURN_QUEUE_VERSION: u64 = 1;
const RUNTIME_TURN_QUEUE_AAD: &[u8] = b"wework-runtime-turn-queue-v1";

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
}

pub(super) fn runtime_turn_queue_path() -> PathBuf {
    runtime_work_dir().join("turn-queue.json")
}

fn runtime_turn_queue_key_path(queue_path: &Path) -> PathBuf {
    queue_path.with_file_name("turn-queue.key")
}

pub(super) fn read_runtime_turn_queue(
    queue_path: &Path,
) -> Result<VecDeque<SpawnTurnRequest>, String> {
    let Ok(envelope_bytes) = fs::read(queue_path) else {
        return Ok(VecDeque::new());
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
    Ok(payload.turns)
}

pub(super) fn write_runtime_turn_queue(
    queue_path: &Path,
    turns: &VecDeque<SpawnTurnRequest>,
) -> Result<(), String> {
    let parent = queue_path
        .parent()
        .ok_or_else(|| "Runtime turn queue path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let key = load_or_create_runtime_turn_queue_key(queue_path)?;
    let plaintext = serde_json::to_vec(&RuntimeTurnQueuePayload {
        version: RUNTIME_TURN_QUEUE_VERSION,
        turns: turns.clone(),
    })
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
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        now_ms()
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

fn hook_user(request: &ExecutionRequest) -> HookUser {
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

impl RuntimeWorkRpcHandler {
    pub(super) async fn persist_turn_queue(
        &self,
        turns: VecDeque<SpawnTurnRequest>,
    ) -> Result<(), AppIpcError> {
        let queue_path = Arc::clone(&self.turn_queue_path);
        tokio::task::spawn_blocking(move || write_runtime_turn_queue(&queue_path, &turns))
            .await
            .map_err(|error| {
                AppIpcError::new(
                    "runtime_queue_failed",
                    format!("Runtime queue writer task failed: {error}"),
                )
            })?
            .map_err(|error| AppIpcError::new("runtime_queue_failed", error))
    }

    pub(super) async fn spawn_turn(&self, mut turn: SpawnTurnRequest) -> Result<(), AppIpcError> {
        self.apply_project_workspace_roots(&mut turn.request);
        let local_task_id = turn.local_task_id.clone();
        let _operation = self.turn_queue_operation.lock().await;
        let (previous, turn_to_start, queued_turns) = {
            let mut scheduler = self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned");
            let previous = scheduler.clone();
            let turn_to_start = scheduler.enqueue(turn);
            let queued_turns = turn_to_start
                .is_none()
                .then(|| scheduler.queued_turns.clone());
            (previous, turn_to_start, queued_turns)
        };
        if let Some(queued_turns) = queued_turns {
            if let Err(error) = self.persist_turn_queue(queued_turns).await {
                *self
                    .turn_scheduler
                    .lock()
                    .expect("runtime turn scheduler lock should not be poisoned") = previous;
                return Err(error);
            }
        }
        drop(_operation);
        if let Some(mut turn) = turn_to_start {
            if let Err(error) = self.prepare_deferred_worktree(&mut turn).await {
                self.finish_scheduled_turn().await;
                return Err(error);
            }
            self.start_turn(turn);
        } else {
            log_executor_event(
                "runtime work turn queued",
                &[("local_task_id", local_task_id)],
            );
        }
        Ok(())
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
        let worktrees = self.worktrees.clone();
        let worktree_id = turn.local_task_id.clone();
        let record = tokio::task::spawn_blocking(move || {
            worktrees.prepare(
                Path::new(&source_path),
                &worktree_id,
                git_ref.as_deref(),
                false,
            )
        })
        .await
        .map_err(|error| {
            AppIpcError::new(
                "worktree_prepare_failed",
                format!("Worktree preparation task failed: {error}"),
            )
        })?
        .map_err(|error| AppIpcError::new("worktree_prepare_failed", error))?;
        turn.request.project_workspace_path = Some(record.path.clone());
        self.store.update_task(&turn.local_task_id, |link| {
            link.workspace_path = record.path.clone();
            link.updated_at = now_ms();
        });
        self.schedule_worktree_prune();
        Ok(())
    }

    fn start_queued_turn(&self, mut turn: SpawnTurnRequest) {
        if !turn
            .request
            .extra
            .contains_key("deferred_worktree_source_path")
        {
            self.start_turn(turn);
            return;
        }
        let handler = self.clone();
        tokio::spawn(async move {
            if let Err(error) = handler.prepare_deferred_worktree(&mut turn).await {
                let local_task_id = turn.local_task_id.clone();
                handler.persist_failed_assistant_message(
                    &local_task_id,
                    &turn.request,
                    &error.message,
                );
                handler.store.update_task(&local_task_id, |link| {
                    link.running = false;
                    link.thread_status = "failed".to_owned();
                    link.turn_status = Some("failed".to_owned());
                    link.updated_at = now_ms();
                    if let Some(runtime_handle) = link.runtime_handle.as_object_mut() {
                        runtime_handle.remove("queuePosition");
                        runtime_handle
                            .insert("lastError".to_owned(), Value::String(error.message.clone()));
                    }
                });
                handler.finish_scheduled_turn().await;
                return;
            }
            handler.start_turn(turn);
        });
    }

    pub(super) fn start_turn(&self, mut turn: SpawnTurnRequest) {
        if is_claude_runtime(&turn.runtime) {
            self.start_claude_turn(turn.local_task_id, turn.request);
            return;
        }
        self.apply_backend_connection(&mut turn.request);
        crate::task_runtime::mcp::ensure_space_mcp_server(&mut turn.request);
        let SpawnTurnRequest {
            local_task_id,
            runtime: _,
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

        let (request_user_input_tx, request_user_input_rx): (
            mpsc::Sender<Value>,
            CodexRequestUserInputReceiver,
        ) = mpsc::channel(1);
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (stopped_tx, stopped_rx) = oneshot::channel();
        let execution_id =
            self.start_local_task_execution(local_task_id.clone(), cancel_tx, stopped_rx);
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
            let _scheduled_turn_guard = ScheduledTurnGuard::new(handler.clone());
            handler.ensure_notification_router().await;
            let (notification_tx, mut notification_rx) = mpsc::unbounded_channel::<Value>();
            let mapper_handler = handler.clone();
            let mapper_local_task_id = turn_local_task_id.clone();
            let mapper_request = request.clone();
            let hook_turn = Arc::new(Mutex::new(None::<ActiveCodexTurn>));
            let mapper_hook_turn = Arc::clone(&hook_turn);
            let mapper_handle = tokio::spawn(async move {
                let mut event_mapper = CodexNotificationEventMapper::default();
                while let Some(message) = notification_rx.recv().await {
                    mapper_handler
                        .sync_runtime_task_goal_from_notification(&mapper_local_task_id, &message);
                    let active_turn = mapper_hook_turn
                        .lock()
                        .expect("hook turn context lock should not be poisoned")
                        .clone();
                    if let (Some(active_turn), Some(cwd)) =
                        (active_turn.as_ref(), mapper_request.cwd())
                    {
                        let resolved_hook_user = hook_user(&mapper_request);
                        let context = CodexHookContext {
                            user: resolved_hook_user.clone(),
                            session_id: active_turn.thread_id.clone(),
                            turn_id: active_turn.turn_id.clone(),
                            cwd: PathBuf::from(cwd),
                            model: string_field(&mapper_request.model_config, "model_id"),
                            permission_mode: "workspace-write".to_owned(),
                        };
                        match post_tool_use_from_notification(&context, &message) {
                            Ok(Some(input)) => {
                                log_executor_event(
                                    "runtime work hook identity resolved",
                                    &[
                                        (
                                            "request_user_name",
                                            mapper_request
                                                .user_name
                                                .clone()
                                                .unwrap_or_else(|| "<none>".to_owned()),
                                        ),
                                        ("hook_user_name", resolved_hook_user.name.clone()),
                                    ],
                                );
                                mapper_handler.hook_service.dispatch(input).await
                            }
                            Ok(None) => {}
                            Err(error) => log_executor_event(
                                "runtime work hook notification mapping failed",
                                &[("error", error.to_string())],
                            ),
                        }
                    }
                    let mut event_request = mapper_request.clone();
                    if let Some(active_turn) = active_turn {
                        mapper_handler.record_active_codex_transcript_item(
                            &mapper_local_task_id,
                            &active_turn.turn_id,
                            &message,
                        );
                        event_request.subtask_id = active_turn.turn_id;
                    }
                    event_mapper.map(
                        &mapper_handler.event_tx,
                        &mapper_handler.device_id,
                        &mapper_local_task_id,
                        &event_request,
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
            let active_turn_execution_id = execution_id;
            let active_turn_subtask_id = request.subtask_id.to_string();
            let active_turn_request = request.clone();
            let callback_hook_turn = Arc::clone(&hook_turn);
            let active_turn_started: CodexActiveTurnCallback =
                Box::new(move |thread_id, turn_id| {
                    *callback_hook_turn
                        .lock()
                        .expect("hook turn context lock should not be poisoned") =
                        Some(ActiveCodexTurn {
                            execution_id: active_turn_execution_id,
                            thread_id: thread_id.clone(),
                            turn_id: turn_id.clone(),
                        });
                    active_turn_handler.record_active_codex_turn(
                        &active_turn_local_task_id,
                        active_turn_execution_id,
                        thread_id,
                        turn_id.clone(),
                    );
                    active_turn_handler
                        .begin_active_codex_transcript(&active_turn_local_task_id, &turn_id);
                    active_turn_handler.record_runtime_turn_id(
                        &active_turn_local_task_id,
                        &active_turn_subtask_id,
                        &turn_id,
                    );
                    let mut event_request = active_turn_request.clone();
                    event_request.subtask_id = turn_id.clone();
                    emit_response_event(
                        &active_turn_handler.event_tx,
                        &active_turn_handler.device_id,
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
            let active_turn_finished: CodexActiveTurnFinishedCallback = Box::new(move || {
                finished_turn_handler
                    .clear_active_codex_turn(&finished_turn_local_task_id, execution_id);
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
                let mut event_request = request.clone();
                if let Some(active_turn) = hook_turn
                    .lock()
                    .expect("hook turn context lock should not be poisoned")
                    .as_ref()
                {
                    event_request.subtask_id = active_turn.turn_id.clone();
                }
                emit_response_event(
                    &handler.event_tx,
                    &handler.device_id,
                    "response.incomplete",
                    &turn_local_task_id,
                    &event_request,
                    json!({
                        "type": "cancelled",
                        "error": {"message": "cancelled"},
                    }),
                );
                let _ = mapper_handle.await;
                handler.clear_active_codex_transcript(&turn_local_task_id);
                handler.finish_local_task(&turn_local_task_id, execution_id, None, "cancelled");
                handler.clear_active_codex_turn(&turn_local_task_id, execution_id);
                handler.mark_thread_event_routes_idle_for_local_task(&turn_local_task_id);
                handler.clear_active_request_user_input(&turn_local_task_id, execution_id);
                let _ = stopped_tx.send(());
                return;
            }

            let _ = mapper_handle.await;
            handler.clear_active_codex_transcript(&turn_local_task_id);
            let active_turn = hook_turn
                .lock()
                .expect("hook turn context lock should not be poisoned")
                .clone();
            handler.handle_turn_result(
                &turn_local_task_id,
                execution_id,
                &request,
                active_turn.as_ref(),
                result,
            );
            handler.clear_active_codex_turn(&turn_local_task_id, execution_id);
            handler.clear_active_request_user_input(&turn_local_task_id, execution_id);
            let _ = stopped_tx.send(());
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
        self.is_active_local_task(local_task_id) || self.is_queued_local_task(local_task_id)
    }

    pub(super) async fn remove_queued_turn(
        &self,
        local_task_id: &str,
    ) -> Result<bool, AppIpcError> {
        let _operation = self.turn_queue_operation.lock().await;
        let (previous, remaining_turns) = {
            let mut scheduler = self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned");
            let Some(position) = scheduler
                .queued_turns
                .iter()
                .position(|turn| turn.local_task_id == local_task_id)
            else {
                return Ok(false);
            };
            let previous = scheduler.clone();
            scheduler.queued_turns.remove(position);
            (previous, scheduler.queued_turns.clone())
        };
        if let Err(error) = self.persist_turn_queue(remaining_turns).await {
            *self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned") = previous;
            return Err(error);
        }
        Ok(true)
    }

    pub(super) async fn finish_scheduled_turn(&self) {
        let _operation = self.turn_queue_operation.lock().await;
        let (previous, turns, remaining_turns) = {
            let mut scheduler = self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned");
            let previous = scheduler.clone();
            let turns = scheduler.finish();
            let remaining_turns = (!turns.is_empty()).then(|| scheduler.queued_turns.clone());
            (previous, turns, remaining_turns)
        };
        if let Some(remaining_turns) = remaining_turns {
            if let Err(error) = self.persist_turn_queue(remaining_turns).await {
                let mut scheduler = self
                    .turn_scheduler
                    .lock()
                    .expect("runtime turn scheduler lock should not be poisoned");
                *scheduler = previous;
                scheduler.active_tasks = scheduler.active_tasks.saturating_sub(1);
                log_executor_event(
                    "runtime turn queue drain persistence failed",
                    &[("error", error.message)],
                );
                return;
            }
        }
        drop(_operation);
        for turn in turns {
            self.start_queued_turn(turn);
        }
    }

    pub(super) async fn update_max_concurrent_tasks(&self, max_concurrent_tasks: usize) {
        let _operation = self.turn_queue_operation.lock().await;
        let (previous, turns, remaining_turns) = {
            let mut scheduler = self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned");
            let previous = scheduler.clone();
            let turns = scheduler.update_limit(max_concurrent_tasks);
            let remaining_turns = (!turns.is_empty()).then(|| scheduler.queued_turns.clone());
            (previous, turns, remaining_turns)
        };
        if let Some(remaining_turns) = remaining_turns {
            if let Err(error) = self.persist_turn_queue(remaining_turns).await {
                let mut scheduler = self
                    .turn_scheduler
                    .lock()
                    .expect("runtime turn scheduler lock should not be poisoned");
                *scheduler = previous;
                scheduler.max_concurrent_tasks = max_concurrent_tasks;
                log_executor_event(
                    "runtime turn queue limit persistence failed",
                    &[("error", error.message)],
                );
                return;
            }
        }
        drop(_operation);
        for turn in turns {
            self.start_queued_turn(turn);
        }
    }

    pub(super) async fn resume_persisted_turns(&self) {
        let _operation = self.turn_queue_operation.lock().await;
        let (previous, turns, remaining_turns) = {
            let mut scheduler = self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned");
            let previous = scheduler.clone();
            let turns = scheduler.take_available();
            if turns.is_empty() {
                return;
            }
            (previous, turns, scheduler.queued_turns.clone())
        };
        if let Err(error) = self.persist_turn_queue(remaining_turns).await {
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
        let mut event_request = request.clone();
        if let Some(active_turn) = active_turn {
            event_request.subtask_id = active_turn.turn_id.clone();
        }
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
                if turn.goal_status_observed {
                    self.sync_runtime_task_goal_status(local_task_id, turn.goal_status.clone());
                }
                self.register_thread_event_route(
                    &thread_id,
                    local_task_id.to_owned(),
                    event_request.clone(),
                    false,
                );
                self.finish_local_task(
                    local_task_id,
                    execution_id,
                    Some(thread_id.clone()),
                    status,
                );
                self.mark_thread_event_route_idle(&thread_id);
                self.register_codex_thread_workspace_root(&thread_id, &event_request);
                let response_item_id = turn.response_item_id;
                match turn.outcome {
                    ExecutionOutcome::Completed { content } => emit_response_event(
                        &self.event_tx,
                        &self.device_id,
                        "response.completed",
                        local_task_id,
                        &event_request,
                        json!({
                            "value": content,
                            "turnId": active_turn.map(|turn| &turn.turn_id),
                            "itemId": response_item_id,
                        }),
                    ),
                    ExecutionOutcome::WaitingForUserInput { stop_reason } => emit_response_event(
                        &self.event_tx,
                        &self.device_id,
                        "response.completed",
                        local_task_id,
                        &event_request,
                        json!({
                            "value": "",
                            "turnId": active_turn.map(|turn| &turn.turn_id),
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
                        &event_request,
                        json!({"error": {"message": message}}),
                    ),
                    ExecutionOutcome::Failed { message } => {
                        self.persist_failed_assistant_message(
                            local_task_id,
                            &event_request,
                            &message,
                        );
                        let mut fields =
                            task_fields(&event_request.task_id, &event_request.subtask_id);
                        fields.push(("local_task_id", local_task_id.to_owned()));
                        fields.push(("error", message.clone()));
                        fields.push(("error_len", message.len().to_string()));
                        log_executor_event("runtime work turn failed", &fields);
                        emit_response_event(
                            &self.event_tx,
                            &self.device_id,
                            "response.failed",
                            local_task_id,
                            &event_request,
                            json!({"error": {"message": message}}),
                        );
                    }
                    ExecutionOutcome::Running => {}
                }
            }
            Err(error) => {
                self.mark_thread_event_routes_idle_for_local_task(local_task_id);
                self.finish_local_task(local_task_id, execution_id, None, "failed");
                self.persist_failed_assistant_message(local_task_id, &event_request, &error);
                let mut fields = task_fields(&event_request.task_id, &event_request.subtask_id);
                fields.push(("local_task_id", local_task_id.to_owned()));
                fields.push(("error", error.clone()));
                fields.push(("error_len", error.len().to_string()));
                log_executor_event("runtime work turn failed", &fields);
                emit_response_event(
                    &self.event_tx,
                    &self.device_id,
                    "response.failed",
                    local_task_id,
                    &event_request,
                    json!({"error": {"message": error}}),
                );
            }
        }
        if let Some((status, error)) = automation_result {
            self.finish_automation_run(local_task_id, status, error.clone());
            self.finish_queue_run(local_task_id, status, error, queue_result_content);
        }
    }

    pub(super) fn persist_failed_assistant_message(
        &self,
        local_task_id: &str,
        request: &ExecutionRequest,
        error: &str,
    ) {
        let timestamp = now_ms();
        let message = json!({
            "id": format!("{local_task_id}:assistant:{}", request.subtask_id),
            "role": "assistant",
            "content": "",
            "status": "failed",
            "error": error,
            "errorType": "response.failed",
            "subtaskId": request.subtask_id,
            "createdAt": timestamp,
            "completedAt": timestamp,
        });
        self.store.update_task(local_task_id, |link| {
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
    ) {
        let Some(workspace_path) = request.cwd() else {
            return;
        };
        if infer_workspace_kind(workspace_path) == "chat" {
            return;
        }
        match register_codex_global_thread_workspace_root(
            thread_id,
            workspace_path,
            request.runtime_project_key.as_deref(),
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scheduled_turn(local_task_id: &str) -> SpawnTurnRequest {
        SpawnTurnRequest {
            local_task_id: local_task_id.to_owned(),
            runtime: "codex".to_owned(),
            request: ExecutionRequest::default(),
            direct_thread_id: None,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: None,
            initial_thread_name: None,
            initial_thread_goal: None,
        }
    }

    #[test]
    fn scheduler_queues_over_limit_and_starts_in_fifo_order() {
        let mut scheduler = RuntimeTurnScheduler::new(2, VecDeque::new());

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
                .finish()
                .into_iter()
                .map(|turn| turn.local_task_id)
                .collect::<Vec<_>>(),
            vec!["task-3"]
        );
        assert_eq!(
            scheduler
                .finish()
                .into_iter()
                .map(|turn| turn.local_task_id)
                .collect::<Vec<_>>(),
            vec!["task-4"]
        );
        assert_eq!(scheduler.active_tasks, 2);
        assert!(scheduler.queued_turns.is_empty());
    }

    #[test]
    fn forced_turn_overcommits_without_releasing_more_queued_work() {
        let mut scheduler = RuntimeTurnScheduler::new(1, VecDeque::new());
        assert!(scheduler.enqueue(scheduled_turn("running")).is_some());
        assert!(scheduler.enqueue(scheduled_turn("forced")).is_none());
        assert!(scheduler.enqueue(scheduled_turn("waiting")).is_none());

        assert_eq!(
            scheduler
                .force_start("forced")
                .map(|turn| turn.local_task_id),
            Some("forced".to_owned())
        );
        assert_eq!(scheduler.active_tasks, 2);
        assert!(scheduler.finish().is_empty());
        assert_eq!(scheduler.active_tasks, 1);
        assert_eq!(
            scheduler
                .finish()
                .into_iter()
                .map(|turn| turn.local_task_id)
                .collect::<Vec<_>>(),
            vec!["waiting"]
        );
        assert_eq!(scheduler.active_tasks, 1);
    }

    #[test]
    fn increasing_limit_starts_queued_turns_immediately() {
        let mut scheduler = RuntimeTurnScheduler::new(1, VecDeque::new());
        assert!(scheduler.enqueue(scheduled_turn("task-1")).is_some());
        assert!(scheduler.enqueue(scheduled_turn("task-2")).is_none());
        assert!(scheduler.enqueue(scheduled_turn("task-3")).is_none());

        let started = scheduler
            .update_limit(3)
            .into_iter()
            .map(|turn| turn.local_task_id)
            .collect::<Vec<_>>();

        assert_eq!(started, vec!["task-2", "task-3"]);
        assert_eq!(scheduler.active_tasks, 3);
        assert!(scheduler.queued_turns.is_empty());
    }

    #[test]
    fn scheduler_reorders_the_real_fifo_queue() {
        let scheduler = RuntimeTurnScheduler::new(
            1,
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
    fn resolves_standard_hook_user_from_execution_request() {
        let mut request = ExecutionRequest {
            user_name: Some("alice".to_owned()),
            ..ExecutionRequest::default()
        };
        request.extra.insert("user_id".to_owned(), json!(42));

        assert_eq!(
            hook_user(&request),
            HookUser {
                id: Some("42".to_owned()),
                name: "alice".to_owned(),
            }
        );
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
