// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Quota waits belong to the durable turn queue, not an occupied native runner.
use super::*;
use crate::agents::CodexQuotaRecovery;
use crate::runtime_work::lifecycle::{queue_native_execution, settle_native_execution};

pub(super) const MARKER: &str = "wegent_quota_recovery";
const RECHECK_MS: i64 = 60_000;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct QuotaWait {
    pub(super) recovery: CodexQuotaRecovery,
    account: Value,
    auth_identity: Option<String>,
    reset_at: Option<i64>,
    next_check_at: i64,
}

pub(super) fn wait(turn: &SpawnTurnRequest) -> Option<QuotaWait> {
    serde_json::from_value(turn.request.extra.get(MARKER)?.clone()).ok()
}

pub(super) fn is_ready(turn: &SpawnTurnRequest, now: i64) -> bool {
    // Malformed records never become an ordinary prompt submission.
    !turn.request.extra.contains_key(MARKER)
        || wait(turn).map_or(true, |wait| wait.next_check_at <= now)
}

pub(super) fn restore_dispatches(state: &mut turns::RuntimeTurnQueueState) {
    for command in state.commands.values_mut() {
        if command.state != command_journal::CommandState::Dispatching
            || !command.turn.request.extra.contains_key(MARKER)
        {
            continue;
        }
        // Dispatch is not proof that the next native turn started. Recheck the
        // exact failed turn before issuing an empty-input continuation.
        command.state = command_journal::CommandState::Queued;
        if !state.queued_turns.iter().any(|turn| {
            turn.local_task_id == command.turn.local_task_id
                && turn.request.subtask_id == command.turn.request.subtask_id
        }) {
            state.queued_turns.push_back(command.turn.clone());
        }
    }
}

fn account_identity(response: &Value) -> Value {
    let account = &response["account"];
    json!({"type": account["type"], "email": account["email"], "id": account["id"]})
}

fn limit_snapshots<'a>(response: &'a Value, model: &Value) -> Vec<&'a Value> {
    let model_id = model
        .get("model_id")
        .or_else(|| model.get("modelId"))
        .and_then(Value::as_str);
    let by_id = response.get("rateLimitsByLimitId");
    let core = by_id
        .and_then(|limits| limits.get("codex"))
        .or_else(|| response.get("rateLimits"))
        .filter(|snapshot| snapshot.is_object());
    let model = model_id
        .filter(|id| *id != "codex")
        .and_then(|id| by_id?.get(id))
        .filter(|snapshot| snapshot.is_object());
    core.into_iter().chain(model).collect()
}

/// Both windows constrain the same model; all exhausted windows must reset.
fn quota_deadline(response: &Value, model: &Value) -> (bool, Option<i64>) {
    let snapshots = limit_snapshots(response, model);
    if snapshots.is_empty() {
        return (true, None);
    }
    let mut blocked = false;
    let mut reset_at = None;
    for snapshot in snapshots {
        let mut available = false;
        for name in ["primary", "secondary"] {
            let window = &snapshot[name];
            let Some(used) = window["usedPercent"]
                .as_f64()
                .filter(|used| used.is_finite())
            else {
                continue;
            };
            available = true;
            if used < 100.0 {
                continue;
            }
            blocked = true;
            let Some(reset) = window["resetsAt"]
                .as_i64()
                .and_then(|v| v.checked_mul(1000))
            else {
                return (true, None);
            };
            reset_at = Some(reset_at.map_or(reset, |previous: i64| previous.max(reset)));
        }
        if !available {
            return (true, None);
        }
    }
    (blocked, reset_at)
}

fn set_wait(turn: &mut SpawnTurnRequest, wait: &QuotaWait) {
    turn.request.extra.insert(MARKER.into(), json!(wait));
}

pub(super) fn validate_model(original: &Value, resolved: &Value) -> Result<(), AppIpcError> {
    let mut original = original.clone();
    let mut resolved = resolved.clone();
    redact_execution_profile_secrets(&mut original);
    redact_execution_profile_secrets(&mut resolved);
    if original != resolved {
        return Err(AppIpcError::new(
            "quota_model_changed",
            "The original model configuration changed; select a model to continue",
        ));
    }
    Ok(())
}

impl RuntimeWorkRpcHandler {
    pub(super) fn cancel_quota_wait_for_goal_change(&self, task: &str, goal: Option<&Value>) {
        let target = self
            .turn_scheduler
            .lock()
            .expect("turn scheduler poisoned")
            .queued_turns
            .iter()
            .filter(|turn| turn.local_task_id == task)
            .filter_map(wait)
            .find(|wait| {
                !crate::agents::same_goal_configuration(wait.recovery.goal.as_ref(), goal)
            });
        let Some(target) = target else { return };
        let handler = self.clone();
        let task = task.to_owned();
        tokio::spawn(async move {
            let _operation = handler.turn_queue_operation.lock().await;
            let (previous, queued) = {
                let mut scheduler = handler
                    .turn_scheduler
                    .lock()
                    .expect("turn scheduler poisoned");
                let previous = scheduler.clone();
                scheduler.queued_turns.retain(|turn| {
                    turn.local_task_id != task
                        || !wait(turn)
                            .is_some_and(|wait| wait.recovery.turn_id == target.recovery.turn_id)
                });
                (previous, scheduler.queued_turns.clone())
            };
            if let Err(error) = handler
                .persist_turn_queue(queued, Some(&previous), &[])
                .await
            {
                *handler
                    .turn_scheduler
                    .lock()
                    .expect("turn scheduler poisoned") = previous;
                log_executor_event(
                    "quota Goal cancellation persistence failed",
                    &[("task_id", task), ("code", error.code)],
                );
            }
        });
    }

    pub(super) fn ensure_quota_waker(&self) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        if self.quota_waker_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let handler = self.clone();
        runtime.spawn(async move {
            loop {
                // Register before inspecting the queue so no queue update is lost.
                let notified = handler.quota_wake.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let deadline = handler.turn_scheduler.lock().expect("turn scheduler poisoned")
                    .queued_turns.iter().filter_map(wait).map(|wait| wait.next_check_at)
                    .filter(|deadline| *deadline > now_ms()).min();
                match deadline {
                    Some(deadline) => tokio::select! {
                        _ = &mut notified => {},
                        _ = sleep(Duration::from_millis(deadline.saturating_sub(now_ms()).clamp(0, RECHECK_MS) as u64)) => {},
                    },
                    None => notified.await,
                }
                if !handler.startup_recovery_deferred.load(Ordering::Acquire) {
                    handler.resume_persisted_turns().await;
                }
            }
        });
    }

    pub(super) fn project_quota_waits(&self, turns: &VecDeque<SpawnTurnRequest>) {
        let waits: HashMap<_, _> = turns
            .iter()
            .filter_map(|turn| {
                let wait = wait(turn)?;
                Some((
                    turn.local_task_id.clone(),
                    json!({
                        "resumeAt": wait.reset_at, "nextCheckAt": wait.next_check_at,
                    }),
                ))
            })
            .collect();
        for link in self.local_task_links(true) {
            let next = waits.get(&link.local_task_id);
            if link.runtime_handle.get("quotaWait") == next {
                continue;
            }
            self.store.update_task(&link.local_task_id, |link| {
                if let Some(next) = next {
                    link.runtime_handle["quotaWait"] = next.clone();
                } else if let Some(handle) = link.runtime_handle.as_object_mut() {
                    handle.remove("quotaWait");
                }
            });
            emit_runtime_work_changed(&self.event_tx, &self.device_id, &link.local_task_id);
        }
    }

    pub(super) async fn defer_quota_turn(
        &self,
        mut turn: SpawnTurnRequest,
        execution_id: u64,
        recovery: CodexQuotaRecovery,
        auth_identity: Option<String>,
    ) -> Result<bool, AppIpcError> {
        let client = self
            .codex_app_server
            .for_request(&turn.request)
            .map_err(quota_error)?;
        if codex_accounts::quota_account_identity(&turn.request).map_err(quota_error)?
            != auth_identity
        {
            return Ok(false);
        }
        let account = client
            .request("account/read", json!({"refreshToken": false}))
            .await
            .ok();
        let limits = client.request("account/rateLimits/read", Value::Null).await;
        let (_, reset_at) = quota_deadline(
            limits.as_ref().unwrap_or(&Value::Null),
            &turn.request.model_config,
        );
        let now = now_ms();
        let wait = QuotaWait {
            recovery: recovery.clone(),
            account: account
                .as_ref()
                .map(account_identity)
                .unwrap_or(Value::Null),
            auth_identity,
            reset_at,
            next_check_at: reset_at
                .filter(|at| *at > now)
                .unwrap_or(now.saturating_add(RECHECK_MS)),
        };
        let _operation = self.turn_queue_operation.lock().await;
        if !self.is_local_task_execution_accepting_notifications(&turn.local_task_id, execution_id)
            || self
                .turn_scheduler
                .lock()
                .expect("turn scheduler poisoned")
                .queued_turns
                .iter()
                .any(|queued| queued.local_task_id == turn.local_task_id)
        {
            return Ok(false);
        }
        turn.request.prompt = json!("");
        for key in [
            "client_user_message_id",
            "clientUserMessageId",
            "runtime_generated_user_message",
            "additionalContext",
            "additional_context",
        ] {
            turn.request.extra.remove(key);
        }
        turn.request.new_session = false;
        turn.send_payload = None;
        turn.direct_thread_id = None;
        turn.fork_thread_id = None;
        turn.fork_thread_path = None;
        turn.resume_thread_id = Some(recovery.thread_id.clone());
        turn.initial_thread_goal = None;
        set_wait(&mut turn, &wait);
        let task = turn.local_task_id.clone();
        self.park_quota_turn_locked(turn, Some(execution_id))
            .await?;
        self.record_overload_recovery_turn(&task, &recovery.turn_id);
        Ok(true)
    }

    async fn park_quota_turn_locked(
        &self,
        turn: SpawnTurnRequest,
        execution: Option<u64>,
    ) -> Result<(), AppIpcError> {
        let task = turn.local_task_id.clone();
        let previous = {
            let mut scheduler = self.turn_scheduler.lock().expect("turn scheduler poisoned");
            let previous = scheduler.clone();
            scheduler.active_task_ids.remove(&task);
            scheduler.queued_turns.push_back(turn);
            previous
        };
        // The quota record replaces the active Goal journal atomically in the same file.
        let previous_goal = self
            .active_goal_turns
            .lock()
            .expect("active Goal map poisoned")
            .remove(&task);
        let queued = self
            .turn_scheduler
            .lock()
            .expect("turn scheduler poisoned")
            .queued_turns
            .clone();
        if let Err(error) = self.persist_turn_queue(queued, Some(&previous), &[]).await {
            *self.turn_scheduler.lock().expect("turn scheduler poisoned") = previous;
            if let Some(goal) = previous_goal {
                self.active_goal_turns
                    .lock()
                    .expect("active Goal map poisoned")
                    .insert(task, goal);
            }
            return Err(error);
        }
        if let Some(execution) = execution {
            self.finish_local_task_execution(&task, execution);
        }
        let position = self.queued_local_task_position(&task).unwrap_or(0);
        self.store.update_task(&task, |link| {
            settle_native_execution(link, "failed");
            queue_native_execution(link, position, false);
        });
        emit_runtime_work_changed(&self.event_tx, &self.device_id, &task);
        Ok(())
    }

    pub(super) async fn start_quota_turn(&self, mut turn: SpawnTurnRequest) {
        let gate = self.task_send_gate(&turn.local_task_id);
        let _send = gate.lock().await;
        if !self
            .local_task_link(&turn.local_task_id)
            .is_some_and(|link| {
                link.status != "archived" && link.thread_id == turn.resume_thread_id
            })
        {
            self.finish_quota_command(&turn).await;
            return;
        }
        let (cancel, cancelled) = oneshot::channel();
        let (stopped, stopped_rx) = oneshot::channel();
        let _stopped = StoppedTurnGuard::new(stopped);
        let execution = {
            let preparing = self
                .preparing_turns
                .lock()
                .expect("preparation map poisoned");
            if preparing
                .get(&turn.local_task_id)
                .map_or(true, |preparation| preparation.cancellation_requested)
            {
                None
            } else {
                Some(self.start_local_task_execution(
                    turn.local_task_id.clone(),
                    cancel,
                    stopped_rx,
                ))
            }
        };
        let Some(execution) = execution else {
            self.finish_quota_command(&turn).await;
            return;
        };
        let Some(mut wait) = wait(&turn) else {
            self.finish_local_task_execution(&turn.local_task_id, execution);
            self.end_quota_turn(&turn, "Invalid saved quota recovery record")
                .await;
            return;
        };
        let checked = tokio::select! {
            biased;
            _ = cancelled => {
                self.finish_local_task_execution(&turn.local_task_id, execution);
                self.store.update_task(&turn.local_task_id, |link| settle_native_execution(link, "cancelled"));
                self.finish_quota_command(&turn).await;
                return;
            }
            checked = self.check_quota_turn(&turn, &wait) => checked,
        };
        if !self.is_local_task_execution_accepting_notifications(&turn.local_task_id, execution) {
            self.finish_local_task_execution(&turn.local_task_id, execution);
            self.finish_quota_command(&turn).await;
            return;
        }
        match checked {
            Ok(Some(reset_at)) => {
                wait.reset_at = reset_at;
                wait.next_check_at = reset_at
                    .filter(|at| *at > now_ms())
                    .unwrap_or(now_ms().saturating_add(RECHECK_MS));
                set_wait(&mut turn, &wait);
            }
            Ok(None) => {
                // The queue reservation is still owned while the native runner starts.
                self.finish_local_task_execution(&turn.local_task_id, execution);
                self.start_turn(turn);
                return;
            }
            Err(error) if error.code == "quota_recovery_cancelled" => {
                self.finish_local_task_execution(&turn.local_task_id, execution);
                self.end_quota_turn(&turn, &error.message).await;
                return;
            }
            Err(error) => {
                log_executor_event(
                    "quota recovery check deferred",
                    &[
                        ("task_id", turn.local_task_id.clone()),
                        ("code", error.code),
                    ],
                );
                wait.next_check_at = now_ms().saturating_add(RECHECK_MS);
                set_wait(&mut turn, &wait);
            }
        }
        let operation = self.turn_queue_operation.clone().lock_owned().await;
        let task = turn.local_task_id.clone();
        if !self.is_local_task_execution_accepting_notifications(&task, execution) {
            drop(operation);
            self.finish_local_task_execution(&task, execution);
            self.finish_quota_command(&turn).await;
            return;
        }
        if let Err(error) = self.park_quota_turn_locked(turn.clone(), None).await {
            drop(operation);
            self.finish_local_task_execution(&turn.local_task_id, execution);
            self.end_quota_turn(&turn, &error.message).await;
            return;
        }
        let cancelled = !self.is_local_task_execution_accepting_notifications(&task, execution);
        self.finish_local_task_execution(&task, execution);
        self.preparing_turns
            .lock()
            .expect("preparation map poisoned")
            .remove(&task);
        if cancelled {
            drop(operation);
            if let Err(error) = self.remove_queued_turn(&task).await {
                log_executor_event(
                    "Quota cancellation persistence failed",
                    &[("task_id", task.clone()), ("code", error.code)],
                );
            }
            self.finish_quota_command(&turn).await;
            return;
        }
        self.finish_scheduled_turn_locked(&task, operation).await;
    }

    async fn check_quota_turn(
        &self,
        turn: &SpawnTurnRequest,
        wait: &QuotaWait,
    ) -> Result<Option<Option<i64>>, AppIpcError> {
        if codex_accounts::quota_account_identity(&turn.request).map_err(quota_error)?
            != wait.auth_identity
        {
            return Err(AppIpcError::new(
                "quota_recovery_cancelled",
                "Quota recovery cancelled because the account changed",
            ));
        }
        let client = self
            .codex_app_server
            .for_request(&turn.request)
            .map_err(quota_error)?;
        let account = client
            .request("account/read", json!({"refreshToken": false}))
            .await
            .map_err(quota_error)?;
        if !wait.account.is_null() && account_identity(&account) != wait.account {
            return Err(AppIpcError::new(
                "quota_recovery_cancelled",
                "Quota recovery cancelled because the account changed",
            ));
        }
        let page = super::super::codex_transcript_page::request_codex_turn_page(&client,
            json!({"threadId": wait.recovery.thread_id, "limit": 1, "sortDirection": "desc", "itemsView": "notLoaded"}),
        ).await.map_err(quota_error)?;
        let latest = page["data"].as_array().and_then(|turns| turns.first());
        let metadata = read_codex_thread_metadata(&client, &wait.recovery.thread_id)
            .await
            .map_err(quota_error)?;
        if latest.and_then(|turn| turn["id"].as_str()) != Some(&wait.recovery.turn_id)
            || latest.and_then(|turn| turn["status"].as_str()) != Some("failed")
            || metadata
                .pointer("/thread/status/type")
                .and_then(Value::as_str)
                == Some("active")
        {
            return Err(AppIpcError::new(
                "quota_recovery_cancelled",
                "Quota recovery cancelled because the conversation changed",
            ));
        }
        let current = client
            .request(
                "thread/goal/get",
                json!({"threadId": wait.recovery.thread_id}),
            )
            .await
            .map_err(quota_error)?;
        if !crate::agents::same_goal_configuration(
            wait.recovery.goal.as_ref(),
            current.get("goal").filter(|goal| !goal.is_null()),
        ) {
            return Err(AppIpcError::new(
                "quota_recovery_cancelled",
                "Quota recovery cancelled because the goal changed",
            ));
        }
        let limits = client
            .request("account/rateLimits/read", Value::Null)
            .await
            .map_err(quota_error)?;
        let (blocked, reset_at) = quota_deadline(&limits, &turn.request.model_config);
        if blocked && reset_at.map_or(true, |at| at > now_ms()) {
            return Ok(Some(reset_at));
        }
        Ok(None)
    }

    async fn end_quota_turn(&self, turn: &SpawnTurnRequest, message: &str) {
        let owns_start =
            self.local_task_link(&turn.local_task_id)
                .is_some_and(|link| {
                    link.status != "archived"
                        && link.thread_id == turn.resume_thread_id
                        && crate::runtime_work::lifecycle::native_execution_state(&link)
                            .is_some_and(|state| {
                                state.phase
                                == crate::runtime_work::lifecycle::NativeExecutionPhase::Starting
                                && state.process_generation.is_none()
                            })
                });
        if owns_start {
            self.retain_failed_runtime_task(
                &turn.local_task_id,
                &AppIpcError::new("quota_recovery_cancelled", message),
            );
        }
        self.finish_quota_command(turn).await;
    }

    pub(super) async fn finish_quota_command(&self, turn: &SpawnTurnRequest) {
        let prepared = self
            .preparing_turns
            .lock()
            .expect("preparation map poisoned")
            .remove(&turn.local_task_id)
            .is_some();
        if prepared && !self.is_active_local_task(&turn.local_task_id) {
            self.store.update_task(&turn.local_task_id, |link| {
                if link.status != "archived"
                    && link.thread_id == turn.resume_thread_id
                    && crate::runtime_work::lifecycle::native_execution_state(link).is_some_and(
                        |state| {
                            state.phase
                                == crate::runtime_work::lifecycle::NativeExecutionPhase::Starting
                                && state.process_generation.is_none()
                        },
                    )
                {
                    settle_native_execution(link, "cancelled");
                }
            });
        }
        let id = turn
            .request
            .extra
            .get("runtime_command_id")
            .and_then(Value::as_str);
        let generation = id
            .and_then(|id| {
                self.command_journal
                    .lock()
                    .expect("command journal poisoned")
                    .get(&command_journal::key(&turn.local_task_id, id))
                    .and_then(|command| {
                        command
                            .native
                            .as_ref()
                            .map(|(generation, _, _)| *generation)
                    })
            })
            .unwrap_or(0);
        self.finish_command_execution(
            &turn.local_task_id,
            generation,
            id,
            Some(command_journal::CommandState::Cancelled),
        )
        .await;
    }
}

fn quota_error(error: String) -> AppIpcError {
    AppIpcError::new("quota_recovery_unavailable", error)
}

#[cfg(test)]
#[path = "quota_recovery_tests.rs"]
mod tests;
