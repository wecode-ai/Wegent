// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::protocol::TaskStatus;
use wegent_execution_contracts::{
    ipc::{PlatformTurn, ShellTurn, TurnObserver},
    RunnerResult,
};

const CANCEL_NEXT: &str = "*";

type Key = (String, String);

pub(super) struct Delivery {
    pub(super) job: Arc<dyn PlatformTurn>,
    shell: Arc<dyn ShellTurn>,
    pub(super) local_session: Option<String>,
    generation: AtomicU64,
    stop_requested: AtomicBool,
    done: tokio::sync::watch::Sender<bool>,
}

impl Delivery {
    pub(super) async fn deliver_queue_cancellation(
        &self,
        handler: &RuntimeWorkRpcHandler,
        key: &Key,
    ) -> Result<(), AppIpcError> {
        let outcome = crate::runner::ExecutionOutcome::Cancelled {
            message: "Task cancelled".into(),
        };
        let Some(event) = self.job.terminal(outcome).await else {
            return Ok(());
        };
        let saved = handler
            .persist_delivery_receipt(
                key,
                &event,
                Some((0, command_journal::CommandState::Cancelled)),
            )
            .await?;
        if !saved {
            return Ok(());
        }
        let result = handler
            .deliver_saved_terminal(key, self.job.as_ref(), event)
            .await;
        self.done.send_replace(true);
        result
    }
}

pub(super) type DeliveryBindings = HashMap<Key, Arc<Delivery>>;

fn submission(session: &str, subtask: &str, mut request: ExecutionRequest) -> SpawnTurnRequest {
    request
        .extra
        .insert("runtime_command_id".into(), json!(subtask));
    request.extra.insert(
        "runtime_command_input".into(),
        json!([
            subtask,
            request.task_id,
            request.subtask_id,
            request.prompt,
            request.workspace_source,
            request.project_workspace_path,
            request.resolved_shell_type()
        ]),
    );
    let runtime = request.resolved_shell_type().unwrap_or_default();
    let mut turn = SpawnTurnRequest::new(session.to_owned(), runtime, request);
    turn.platform_command = Some(subtask.to_owned());
    turn.task_kind = Some(RuntimeTaskKind::Agent);
    turn
}

impl RuntimeWorkRpcHandler {
    pub(super) fn active_platform_tasks(&self, scope: &str) -> Vec<String> {
        let active = self
            .active_local_executions
            .lock()
            .expect("execution registry poisoned");
        let mut tasks: Vec<_> = active
            .values()
            .filter_map(|entry| {
                let (session, delivery) = entry.platform_task.as_ref()?;
                let task = delivery.task_id();
                (delivery.authorized()
                    && *session == crate::runner::platform_session_key(scope, task))
                .then(|| task.to_owned())
            })
            .collect();
        tasks.sort_unstable();
        tasks
    }

    fn bound_local_session(
        &self,
        request: &ExecutionRequest,
        backend_origin: Option<&str>,
    ) -> Result<Option<String>, AppIpcError> {
        let Some(thread) = crate::agent_session::resumed_session_id(request) else {
            return Ok(None);
        };
        let owner = request
            .extra
            .get("user_id")
            .and_then(Value::as_i64)
            .filter(|owner| *owner > 0);
        let device = self.cloud_device_id()?;
        let mapped = owner.zip(backend_origin).and_then(|(owner, origin)| {
            self.local_task_link(&super::platform_continuation::continuation_id(
                origin,
                owner,
                &device,
                &request.task_id,
            ))
        });
        let Some(local) = mapped.or_else(|| self.local_task_by_thread_id(&thread)) else {
            return Ok(None);
        };
        let Some(provenance) = local.execution_backend.as_ref() else {
            // A historical session with no host-authenticated origin retains independent delivery.
            return Ok(None);
        };
        let Some(task_id) = provenance.task_id.as_deref() else {
            return Ok(None);
        };
        let local_origin = provenance.url.as_str();
        let same_backend = backend_origin.map(|url| url.trim_end_matches('/'))
            == Some(local_origin)
            && request
                .backend_url
                .as_ref()
                .map_or(true, |url| url.trim_end_matches('/') == local_origin);
        let same_shell = request
            .resolved_shell_type()
            .is_some_and(|shell| shell.eq_ignore_ascii_case(&local.runtime.replace('_', "")));
        if runtime_session_id_from_link(&local).as_deref() != Some(thread.as_str())
            || task_id != request.task_id
            || owner.is_none()
            || Some(provenance.owner) != owner
            || provenance.device != device
            || local.runtime_handle["executionRequest"]["user_id"].as_i64() != owner
            || request.device_id.as_deref() != Some(device.as_str())
            || !same_shell
            || !same_backend
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "The resumed session belongs to a different execution identity",
            ));
        }
        Ok(Some(local.local_task_id))
    }

    pub(super) async fn admit_platform_turn(
        &self,
        session: String,
        subtask: String,
        job: Arc<dyn PlatformTurn>,
        shell: Arc<dyn ShellTurn>,
    ) -> Result<RunnerResult, AppIpcError> {
        let turn = submission(&session, &subtask, job.request());
        let local_session = self.bound_local_session(&turn.request, job.backend_origin())?;
        let delivery = Arc::new(Delivery {
            job,
            shell,
            local_session,
            generation: AtomicU64::new(0),
            stop_requested: AtomicBool::new(false),
            done: tokio::sync::watch::channel(false).0,
        });
        let (_, status) = self
            .submit_turn(
                turn,
                super::turns::TurnAdmission::Normal,
                Some(((session, subtask), delivery)),
            )
            .await?;
        Ok(RunnerResult::accepted(status))
    }

    pub(super) async fn delivery_receipt_locked(
        &self,
        turn: &SpawnTurnRequest,
        key: &Key,
    ) -> Result<Option<TaskStatus>, AppIpcError> {
        let command = command_journal::RuntimeCommand::from_turn(
            turn,
            command_journal::CommandState::Queued,
        )?
        .expect("platform turn has command identity");
        let state = {
            let journal = self
                .command_journal
                .lock()
                .expect("command journal poisoned");
            command_journal::replayed_command(&journal, &command)?.map(|entry| entry.state.clone())
        };
        if let Some(state) = &state {
            use command_journal::CommandState::*;
            let status = match state {
                Queued
                    if !self
                        .turn_scheduler
                        .lock()
                        .expect("turn scheduler poisoned")
                        .platform_turns
                        .contains_key(key) =>
                {
                    None
                }
                Queued => Some(TaskStatus::Pending),
                Dispatching | Started | AwaitingUser => Some(TaskStatus::Running),
                Failed | RecoveryRequired => Some(TaskStatus::Failed),
                Settled => Some(TaskStatus::Completed),
                Cancelled => Some(TaskStatus::Cancelled),
            };
            if let Some(status) = status {
                return Ok(Some(status));
            }
        }
        let wildcard = command_journal::key(&key.0, CANCEL_NEXT);
        let pending_cancel = self
            .command_journal
            .lock()
            .expect("command journal poisoned")
            .remove(&wildcard);
        if let Some(pending_cancel) = pending_cancel {
            let cancelled = command_journal::RuntimeCommand::from_turn(
                turn,
                command_journal::CommandState::Cancelled,
            )?
            .expect("platform turn has command identity");
            let key = cancelled.key();
            self.command_journal
                .lock()
                .expect("command journal poisoned")
                .insert(key.clone(), cancelled);
            let queued = self
                .turn_scheduler
                .lock()
                .expect("turn scheduler poisoned")
                .queued_turns
                .clone();
            if let Err(error) = self.persist_turn_queue(queued, None, &[]).await {
                let mut journal = self
                    .command_journal
                    .lock()
                    .expect("command journal poisoned");
                journal.remove(&key);
                journal.insert(wildcard, pending_cancel);
                return Err(error);
            }
            return Ok(Some(TaskStatus::Cancelled));
        }
        Ok(None)
    }

    fn platform_session_observer(
        &self,
        session: &str,
        generation: u64,
        request: &ExecutionRequest,
        transcript: Arc<Mutex<super::claude_turns::TurnTranscript>>,
    ) -> TurnObserver {
        let handler = self.clone();
        let task = session.to_owned();
        let mut request = request.clone();
        let runtime = if request.resolved_agent_kind() == crate::protocol::AgentKind::CodeX {
            "codex"
        } else {
            "claude_code"
        };
        request.extra.insert("source".into(), json!({
            "source":"platform_projection", "task_id":request.task_id, "subtask_id":request.subtask_id,
            "execution_attempt_id":request.extra.get("execution_attempt_id")
        }));
        Arc::new(move |event| {
            if !handler.is_current_local_task_execution(&task, generation) {
                return;
            }
            transcript
                .lock()
                .expect("turn transcript poisoned")
                .record(event);
            super::super::events::emit_shell_response_event(
                &handler.event_tx,
                &handler.device_id,
                runtime,
                &event.event_type,
                &task,
                &request,
                event.data.clone(),
            );
        })
    }

    pub(super) fn delivery_for_turn(&self, turn: &SpawnTurnRequest) -> Option<Arc<Delivery>> {
        let attempt = turn.platform_command.as_ref()?;
        Some(
            self.turn_scheduler
                .lock()
                .expect("turn scheduler poisoned")
                .platform_turns
                .get(&(turn.local_task_id.clone(), attempt.clone()))
                .cloned()
                .expect("admitted platform delivery"),
        )
    }

    pub(super) fn prepare_delivery_shell(
        &self,
        turn: SpawnTurnRequest,
        binding: Arc<Delivery>,
    ) -> PreparedShell<'_> {
        let handler = self.clone();
        let key = (
            turn.local_task_id,
            turn.platform_command
                .expect("authenticated platform attempt"),
        );
        let request = binding.job.request();
        let session = handler
            .bound_local_session(&request, binding.job.backend_origin())
            .and_then(|local| {
                if local == binding.local_session {
                    Ok(local)
                } else {
                    Err(AppIpcError::new(
                        "session_changed",
                        "The resumed session changed while the execution was queued",
                    ))
                }
            });
        let local_session = session.as_ref().ok().cloned().flatten();
        let control = local_session.clone().unwrap_or_else(|| key.0.clone());
        let session_key = control.clone();
        PreparedShell::new(
            session_key,
            key.0.clone(),
            Some(key.1.clone()),
            Some(binding.job.clone()),
            move |generation, rx, guard| {
                binding.generation.store(generation, Ordering::SeqCst);
                if binding.stop_requested.load(Ordering::SeqCst) {
                    handler.request_execution_generation_stop(&control, generation);
                }
                let transcript =
                    Arc::new(Mutex::new(super::claude_turns::TurnTranscript::default()));
                let observer = local_session.as_deref().map(|local| {
                    handler.platform_session_observer(
                        local,
                        generation,
                        &request,
                        transcript.clone(),
                    )
                });
                binding.job.starting(observer);
                async move {
                    let completion = guard;
                    let job = &binding.job;
                    let launch = match &session {
                        Ok(_) => job.created().await,
                        Err(error) => Err(error.message.clone()),
                    };
                    let outcome = match launch {
                        Ok(()) => {
                            if let Some(local) = local_session.as_deref() {
                                if let Some(link) = handler.store.get_task_summary(local) {
                                    handler.publish_native_execution(local, &request, link);
                                }
                                let payload = json!({"message":prompt_text(&request.prompt)});
                                if let Some(message) =
                                    cached_user_message(local, &request, &payload)
                                {
                                    handler.store.update_task_without_snapshot(local, |link| {
                                        append_runtime_handle_message(
                                            &mut link.runtime_handle,
                                            message,
                                        );
                                    });
                                }
                            }
                            crate::runner::run_bound_shell(
                                binding.shell.as_ref(),
                                rx,
                                "Task cancelled",
                            )
                            .await
                        }
                        Err(message) => crate::runner::ExecutionOutcome::Failed { message },
                    };
                    let terminal = job.terminal(outcome.clone()).await;
                    if handler.finish_local_task_execution(&control, generation)
                        && matches!(session, Ok(Some(_)))
                    {
                        if let Some(settlement) =
                            super::turns::TurnSettlement::from_outcome(Ok(&outcome))
                        {
                            handler.store.update_task(&control, |link| {
                                super::execution_control::settle_local_execution_link(
                                    link,
                                    None,
                                    settlement.status,
                                );
                                if matches!(
                                    outcome,
                                    crate::runner::ExecutionOutcome::WaitingForUserInput { .. }
                                ) {
                                    link.interaction_status =
                                        Some(INTERACTION_AWAITING_USER_REPLY.into());
                                }
                            });
                            handler.persist_shell_assistant_message(
                                &control,
                                &request,
                                settlement.content.as_deref().unwrap_or_default(),
                                transcript
                                    .lock()
                                    .expect("turn transcript poisoned")
                                    .blocks(),
                                settlement.status,
                                settlement
                                    .reason
                                    .as_deref()
                                    .filter(|_| settlement.content.is_none()),
                            );
                            if let Some(link) = handler.local_task_link(&control) {
                                if link.runtime == "codex" {
                                    handler.publish_native_execution(&control, &request, link);
                                } else {
                                    handler.project_runtime_link_status_now(&link);
                                }
                            }
                        }
                    }
                    let mut state = command_journal::CommandState::from_execution(&outcome);
                    if let Some(event) = terminal {
                        let saved = handler
                            .persist_delivery_receipt(
                                &key,
                                &event,
                                Some((generation, state.clone())),
                            )
                            .await;
                        if let Err(error) = saved {
                            state = command_journal::CommandState::RecoveryRequired;
                            log_executor_event(
                                "platform terminal persistence failed",
                                &[("code", error.code)],
                            );
                        }
                        completion.deliver_after_release(job.clone(), event);
                    }
                    completion.settle(state);
                }
            },
        )
    }

    /// Commit the exact Socket frame under the same encrypted queue transaction as the outcome.
    /// A lost acknowledgement replays this frame without re-running the Shell or the local observer.
    pub(super) async fn persist_delivery_receipt(
        &self,
        key: &Key,
        terminal: &crate::emitter::EventEnvelope,
        new_outcome: Option<(u64, command_journal::CommandState)>,
    ) -> Result<bool, AppIpcError> {
        let _operation = self.turn_queue_operation.lock().await;
        let id = command_journal::key(&key.0, &key.1);
        let previous = {
            let mut journal = self
                .command_journal
                .lock()
                .expect("command journal poisoned");
            let command = journal
                .get_mut(&id)
                .ok_or_else(|| AppIpcError::new("command_missing", "Missing terminal command"))?;
            let previous = command.clone();
            if let Some((generation, state)) = new_outcome {
                let queued_cancel = generation == 0
                    && state == command_journal::CommandState::Cancelled
                    && command.state == state;
                if queued_cancel && command.pending_terminal.is_some() {
                    return Ok(false);
                }
                if !queued_cancel && !command.finish(Some(generation), state) {
                    return Err(AppIpcError::new(
                        "command_changed",
                        "Terminal execution no longer owns command",
                    ));
                }
                command.pending_terminal = Some(command_journal::TerminalDelivery::Pending(
                    Box::new(terminal.clone()),
                ));
            } else if matches!(command.pending_terminal.as_ref(), Some(command_journal::TerminalDelivery::Pending(event)) if event.as_ref() == terminal)
            {
                command.pending_terminal = Some(command_journal::TerminalDelivery::Acknowledged);
            } else {
                return Ok(false);
            }
            previous
        };
        let queued = self
            .turn_scheduler
            .lock()
            .expect("turn scheduler poisoned")
            .queued_turns
            .clone();
        if let Err(error) = self.persist_turn_queue(queued, None, &[]).await {
            self.command_journal
                .lock()
                .expect("command journal poisoned")
                .insert(id, previous);
            return Err(error);
        }
        Ok(true)
    }

    pub(super) async fn deliver_saved_terminal(
        &self,
        key: &Key,
        job: &dyn PlatformTurn,
        event: crate::emitter::EventEnvelope,
    ) -> Result<(), AppIpcError> {
        job.deliver_terminal(event.clone())
            .await
            .map_err(|error| AppIpcError::new("delivery_unconfirmed", error))?;
        self.persist_delivery_receipt(key, &event, None)
            .await
            .map(|_| ())
    }

    pub(super) fn close_delivery(&self, session: &str, command: &str, generation: u64) {
        let key = (session.to_owned(), command.to_owned());
        let mut scheduler = self.turn_scheduler.lock().expect("turn scheduler poisoned");
        if scheduler
            .platform_turns
            .get(&key)
            .is_some_and(|delivery| delivery.generation.load(Ordering::Acquire) == generation)
        {
            let delivery = scheduler
                .platform_turns
                .remove(&key)
                .expect("registered delivery");
            delivery.done.send_replace(true);
        }
    }

    pub(super) async fn stop_platform_turn(
        &self,
        session: String,
        subtask: Option<String>,
        remember: bool,
        suspended: wegent_execution_contracts::ipc::CancelSuspendedTurn,
    ) -> bool {
        let operation = self.turn_queue_operation.lock().await;
        let binding = {
            let scheduler = self.turn_scheduler.lock().expect("turn scheduler poisoned");
            match subtask.as_ref() {
                Some(id) => scheduler
                    .platform_turns
                    .get_key_value(&(session.clone(), id.clone())),
                None => {
                    let active = scheduler
                        .platform_turns
                        .iter()
                        .find(|((task, _), binding)| {
                            task == &session
                                && self.is_current_local_task_execution(
                                    binding.local_session.as_deref().unwrap_or(task),
                                    binding.generation.load(Ordering::Acquire),
                                )
                        });
                    active
                        .or_else(|| {
                            scheduler.queued_turns.iter().find_map(|turn| {
                                (turn.local_task_id == session)
                                    .then(|| {
                                        scheduler.platform_turns.get_key_value(&(
                                            session.clone(),
                                            turn.platform_command.clone()?,
                                        ))
                                    })
                                    .flatten()
                            })
                        })
                        .or_else(|| {
                            scheduler
                                .platform_turns
                                .iter()
                                .find(|((task, _), binding)| {
                                    task == &session
                                        && binding.generation.load(Ordering::Acquire) == 0
                                })
                        })
                }
            }
            .map(|(key, binding)| (key.clone(), binding.clone()))
        };
        let Some((key, binding)) = binding else {
            if let Some((attempt, deliver)) = suspended() {
                let key = command_journal::key(&session, &attempt);
                let changed = self
                    .command_journal
                    .lock()
                    .expect("command journal poisoned")
                    .get_mut(&key)
                    .is_some_and(|command| {
                        if command.state != command_journal::CommandState::AwaitingUser {
                            return false;
                        }
                        command.state = command_journal::CommandState::Cancelled;
                        true
                    });
                if changed {
                    let queued = self
                        .turn_scheduler
                        .lock()
                        .expect("turn scheduler poisoned")
                        .queued_turns
                        .clone();
                    if let Err(error) = self.persist_turn_queue(queued, None, &[]).await {
                        log_executor_event(
                            "suspended cancellation persistence failed",
                            &[("code", error.code)],
                        );
                    }
                }
                drop(operation);
                return deliver.await;
            }
            if !remember {
                return false;
            }
            let id = subtask.as_deref().unwrap_or(CANCEL_NEXT);
            let key = command_journal::key(&session, id);
            let marker = submission(
                &session,
                id,
                ExecutionRequest {
                    subtask_id: id.to_owned(),
                    ..Default::default()
                },
            );
            // A restored queued command still carries its original owner and fingerprint.
            // Cancelling the queue entry retires it through the common journal transaction.
            match self
                .remove_queued_command_locked(&session, Some(id), false)
                .await
            {
                Ok(Some(_)) => return true,
                Err(_) => return false,
                Ok(None) => {}
            }
            let Ok(Some(cancelled)) = command_journal::RuntimeCommand::from_turn(
                &marker,
                command_journal::CommandState::Cancelled,
            ) else {
                return false;
            };
            {
                let mut journal = self
                    .command_journal
                    .lock()
                    .expect("command journal poisoned");
                if journal.contains_key(&key) {
                    return false;
                }
                journal.insert(key.clone(), cancelled);
            }
            let queued = self
                .turn_scheduler
                .lock()
                .expect("turn scheduler poisoned")
                .queued_turns
                .clone();
            if self.persist_turn_queue(queued, None, &[]).await.is_err() {
                self.command_journal
                    .lock()
                    .expect("command journal poisoned")
                    .remove(&key);
                return false;
            }
            return true;
        };
        if !binding.job.authorized() {
            return false;
        }
        let Ok(removed) = self
            .remove_queued_command_locked(&key.0, Some(&key.1), false)
            .await
        else {
            return false;
        };
        if removed.is_none() {
            let mut done = binding.done.subscribe();
            binding.stop_requested.store(true, Ordering::SeqCst);
            let generation = binding.generation.load(Ordering::SeqCst);
            self.request_execution_generation_stop(
                binding.local_session.as_deref().unwrap_or(&key.0),
                generation,
            );
            drop(operation);
            return done.wait_for(|done| *done).await.is_ok();
        }
        drop(operation);
        binding.deliver_queue_cancellation(self, &key).await.is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::ExecutionOutcome;
    use wegent_execution_contracts::ipc::BoxFuture;

    #[derive(Default)]
    struct CountedTurn {
        starts: AtomicU64,
        queued_cancellations: AtomicU64,
        failed_ack: AtomicBool,
        awaiting_ack: tokio::sync::Notify,
        lose_ack: tokio::sync::Notify,
        delivered: Mutex<Vec<crate::emitter::EventEnvelope>>,
        started: tokio::sync::Notify,
        finish: tokio::sync::Notify,
        request: ExecutionRequest,
        observer: std::sync::OnceLock<TurnObserver>,
    }

    impl PlatformTurn for CountedTurn {
        fn request(&self) -> ExecutionRequest {
            self.request.clone()
        }
        fn task_id(&self) -> &str {
            &self.request.task_id
        }
        fn authorized(&self) -> bool {
            true
        }
        fn backend_origin(&self) -> Option<&str> {
            Some("https://backend-a.example")
        }
        fn starting(&self, observer: Option<TurnObserver>) {
            if let Some(observer) = observer {
                assert!(self.observer.set(observer).is_ok());
            }
            self.starts.fetch_add(1, Ordering::Relaxed);
        }

        fn created(&self) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn terminal(
            &self,
            outcome: ExecutionOutcome,
        ) -> BoxFuture<'_, Option<crate::emitter::EventEnvelope>> {
            Box::pin(async move {
                let builder = crate::emitter::ResponsesEventBuilder::new("11", "1", "test");
                let event = crate::runner::result_event(&builder, outcome).unwrap();
                if let Some(observer) = self.observer.get() {
                    observer(&event);
                } else {
                    self.queued_cancellations.fetch_add(1, Ordering::Relaxed);
                }
                Some(event)
            })
        }

        fn deliver_terminal(
            &self,
            event: crate::emitter::EventEnvelope,
        ) -> BoxFuture<'_, Result<(), String>> {
            self.delivered.lock().unwrap().push(event);
            Box::pin(async {
                if self.failed_ack.swap(false, Ordering::Relaxed) {
                    self.awaiting_ack.notify_one();
                    self.lose_ack.notified().await;
                    Err("ack lost".into())
                } else {
                    Ok(())
                }
            })
        }
    }

    impl ShellTurn for CountedTurn {
        fn interrupt(&self) {}
        fn start(&self) -> BoxFuture<'_, ExecutionOutcome> {
            Box::pin(async {
                self.started.notify_one();
                self.finish.notified().await;
                ExecutionOutcome::Completed {
                    content: "ok".into(),
                }
            })
        }
    }

    #[test]
    fn local_capacity_queues_platform_work_and_restored_attempts_attach_once() {
        crate::test_env::run_with_executor_home(verify_platform_queue_recovery());
    }

    async fn verify_platform_queue_recovery() {
        let handler = RuntimeWorkRpcHandler::new("device", "unused");
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "local".into(),
            runtime: "codex".into(),
            thread_id: Some("shared-thread".into()),
            runtime_handle: json!({"executionRequest":{"user_id":7},"origin":{"backendUrl":"https://backend-a.example"},"executionBackend":{"backendUrl":"https://backend-a.example","userId":7,"deviceId":"device"}}),
            ..Default::default()
        });
        {
            let mut scheduler = handler.turn_scheduler.lock().unwrap();
            scheduler.settings = RuntimeSettings::uniform(2);
            let mut local =
                SpawnTurnRequest::new("local".into(), "codex".into(), Default::default());
            local.task_kind = Some(RuntimeTaskKind::Agent);
            assert!(scheduler.enqueue(local).is_some());
        }
        let request: ExecutionRequest = serde_json::from_value(json!({
            "task_id":"11","subtask_id":"1","device_id":"device","user_id":7,"backend_url":"https://backend-a.example","bot":[{"shell_type":"Codex"}],
            "inherited_sessions":[{"agent":"Codex","threadId":"shared-thread"}]
        })).unwrap();
        assert_eq!(
            handler
                .bound_local_session(&request, Some("https://backend-a.example"))
                .unwrap(),
            None
        );
        *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {
            backend_url: "https://backend-a.example".into(),
            authenticated_user_id: Some(7),
            ..Default::default()
        });
        handler.store.update_task("local", |link| {
            link.execution_backend = Some(super::super::super::response::ExecutionBackend {
                url: "https://backend-a.example".into(),
                owner: 7,
                device: "device".into(),
                task_id: None,
            });
        });
        assert_eq!(
            handler
                .bound_local_session(&request, Some("https://backend-a.example"))
                .unwrap(),
            None
        );
        handler.store.update_task("local", |link| {
            link.execution_backend.as_mut().unwrap().task_id = Some("11".into());
        });
        assert_eq!(
            handler
                .bound_local_session(&request, Some("https://backend-b.example"))
                .unwrap_err()
                .code,
            "permission_denied"
        );
        let mut wrong_task = request.clone();
        wrong_task.task_id = "12".into();
        assert_eq!(
            handler
                .bound_local_session(&wrong_task, Some("https://backend-a.example"))
                .unwrap_err()
                .code,
            "permission_denied"
        );
        let mut foreign = request.clone();
        foreign.extra.insert("user_id".into(), json!(8));
        assert_eq!(
            handler
                .bound_local_session(&foreign, Some("https://backend-a.example"))
                .unwrap_err()
                .code,
            "permission_denied"
        );
        let cancelled = Arc::new(CountedTurn {
            request: ExecutionRequest {
                subtask_id: "2".into(),
                ..request.clone()
            },
            ..Default::default()
        });
        handler
            .admit_platform_turn(
                "session".into(),
                "2".into(),
                cancelled.clone(),
                cancelled.clone(),
            )
            .await
            .unwrap();
        assert!(handler.remove_queued_turn("local").await.unwrap());
        assert_eq!(cancelled.starts.load(Ordering::Relaxed), 0);
        assert_eq!(cancelled.queued_cancellations.load(Ordering::Relaxed), 1);
        let job = Arc::new(CountedTurn {
            failed_ack: AtomicBool::new(true),
            request,
            ..Default::default()
        });
        let result = handler
            .admit_platform_turn("session".into(), "1".into(), job.clone(), job.clone())
            .await
            .unwrap();
        assert_eq!(result.status, TaskStatus::Pending);
        assert_eq!(job.starts.load(Ordering::Relaxed), 0);
        drop(handler);
        let (events, mut subscriber) = broadcast::channel(32);
        let mut restored = RuntimeWorkRpcHandler::new("device", "unused");
        restored.event_tx = Some(events);
        restored.resume_persisted_turns().await;
        assert_eq!(job.starts.load(Ordering::Relaxed), 0);
        let result = restored
            .admit_platform_turn("session".into(), "1".into(), job.clone(), job.clone())
            .await
            .unwrap();
        assert_eq!(result.status, TaskStatus::Running);
        job.started.notified().await;
        assert_eq!(
            restored
                .admit_platform_turn("session".into(), "1".into(), job.clone(), job.clone())
                .await
                .unwrap()
                .status,
            TaskStatus::Running
        );
        let local = SpawnTurnRequest::new("local".into(), "codex".into(), Default::default());
        assert!(restored
            .turn_scheduler
            .lock()
            .unwrap()
            .session_reserved(&local));
        let binding = restored
            .turn_scheduler
            .lock()
            .unwrap()
            .platform_turns
            .get(&("session".into(), "1".into()))
            .cloned()
            .expect("delivery remains attached until the Shell exits");
        let mut finished = binding.done.subscribe();
        job.finish.notify_one();
        tokio::time::timeout(Duration::from_secs(3), job.awaiting_ack.notified())
            .await
            .expect("terminal handed to Socket");
        assert!(
            !restored
                .turn_scheduler
                .lock()
                .unwrap()
                .session_reserved(&local),
            "Socket acknowledgements cannot hold Shell capacity"
        );
        job.lose_ack.notify_one();
        tokio::time::timeout(Duration::from_secs(3), finished.wait_for(|done| *done))
            .await
            .expect("Shell settlement releases the reservation")
            .unwrap();
        assert!(!restored
            .turn_scheduler
            .lock()
            .unwrap()
            .session_reserved(&local));
        let mut terminal = Vec::new();
        while let Ok(event) = subscriber.try_recv() {
            if event["event"] == "response.completed" {
                terminal.push(event["payload"].clone());
            }
        }
        assert_eq!(terminal.len(), 1);
        assert_eq!(terminal[0]["taskId"], "local");
        assert_eq!(terminal[0]["source"]["task_id"], "11");
        assert_eq!(terminal[0]["source"]["subtask_id"], "1");
        assert_eq!(
            terminal[0]["data"]["response"]["output"][0]["content"][0]["text"],
            "ok"
        );
        let replay = RuntimeWorkRpcHandler::new("device", "unused");
        let result = replay
            .admit_platform_turn("session".into(), "1".into(), job.clone(), job.clone())
            .await
            .unwrap();
        let receipts = job.delivered.lock().unwrap().clone();
        assert_eq!(receipts.len(), 2);
        assert_eq!(receipts[0], receipts[1]);
        assert_eq!(result.status, TaskStatus::Completed);
        assert_eq!(job.starts.load(Ordering::Relaxed), 1);
    }
}
