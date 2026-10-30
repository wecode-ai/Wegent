// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::runtime_work::{
    codex_notifications::is_root_codex_turn_event, events::next_runtime_event_sequence,
    response::local_task_json, util::timestamp_ms_field,
};

use crate::runtime_work::lifecycle::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn sync_native_queue_admissions(
        &self,
        mut previous: HashSet<String>,
        current: Vec<(String, bool)>,
    ) {
        let active = self
            .turn_scheduler
            .lock()
            .expect("runtime turn scheduler lock should not be poisoned")
            .active_task_ids
            .clone();
        let mut positions = HashMap::new();
        for (position, (task_id, recovering)) in current.into_iter().enumerate() {
            positions
                .entry(task_id.clone())
                .or_insert((position, recovering));
            previous.insert(task_id);
        }
        for task_id in previous {
            let mut changed = false;
            self.store.update_task(&task_id, |link| {
                let before = native_execution_state(link);
                if active.contains(&task_id) {
                    if before
                        .as_ref()
                        .is_some_and(|state| state.awaits_admission())
                    {
                        begin_native_request(link);
                    }
                } else if let Some((position, recovering)) = positions.get(&task_id) {
                    queue_native_execution(link, *position, *recovering);
                } else if before
                    .as_ref()
                    .is_some_and(|state| state.awaits_admission())
                {
                    settle_native_execution(link, "cancelled");
                }
                changed = before != native_execution_state(link);
            });
            if changed {
                emit_runtime_work_changed(&self.event_tx, &self.device_id, &task_id);
            }
        }
    }

    pub(super) fn settle_native_transport_exit(&self, generation: u64) {
        for task in self.local_task_links(true) {
            if !native_execution_state(&task).is_some_and(|state| {
                state.phase != NativeExecutionPhase::Idle
                    && !state.awaits_admission()
                    && state.process_generation == Some(generation)
            }) {
                continue;
            }
            if let Some(link) = self.store.update_task(&task.local_task_id, |link| {
                if native_execution_state(link)
                    .is_some_and(|state| state.process_generation == Some(generation))
                {
                    settle_native_execution(link, "cancelled");
                }
            }) {
                let request = ExecutionRequest {
                    task_id: task.local_task_id.clone(),
                    ..Default::default()
                };
                self.publish_native_execution(&task.local_task_id, &request, link);
            }
        }
    }

    pub(super) fn emit_task_response(
        &self,
        event: &str,
        task_id: &str,
        request: &ExecutionRequest,
        mut data: Value,
    ) {
        if let Some(link) = self.local_task_link(task_id) {
            data["task"] = local_task_json(link);
        }
        emit_response_event(
            &self.event_tx,
            &self.device_id,
            event,
            task_id,
            request,
            data,
        );
    }

    pub(super) fn settle_native_request_journal(&self, task_id: &str, needs_attention: bool) {
        let Some(link) = self.local_task_link(task_id) else {
            return;
        };
        if link.goal_status.as_deref() != Some("active") {
            self.clear_active_goal_turn(task_id);
        } else if needs_attention {
            self.mark_active_goal_turn_needs_attention(task_id);
        } else if !native_execution_state(&link)
            .is_some_and(|state| state.phase != NativeExecutionPhase::Idle)
        {
            self.clear_active_goal_turn(task_id);
        }
    }

    // The delivery owner feeds one lifecycle reducer; content mappers never own task state.
    pub(super) fn apply_native_lifecycle(
        &self,
        task_id: &str,
        request: &ExecutionRequest,
        message: &CodexNotification,
    ) {
        let notification = codex_notification(message);
        if !matches!(
            notification.method.as_str(),
            "turn/started"
                | "turn/completed"
                | "thread/goal/updated"
                | "thread/goal/cleared"
                | "error"
        ) || !is_root_codex_turn_event(notification.params)
            || self.store.read_task(task_id, |link| {
                codex_notification_thread_id(message)
                    .is_some_and(|thread| link.thread_id.as_deref() != Some(thread.as_str()))
            }) == Some(true)
        {
            return;
        }
        if matches!(notification.method.as_str(), "error")
            && notification.params["willRetry"] == true
        {
            self.apply_native_recovery(task_id, request, message);
            return;
        }
        if matches!(
            notification.method.as_str(),
            "thread/goal/updated" | "thread/goal/cleared"
        ) {
            if self
                .local_task_link(task_id)
                .and_then(|link| native_execution_state(&link))
                .is_some_and(|state| state.native_sequence >= message.sequence())
            {
                return;
            }
            if self.sync_runtime_task_goal_from_notification(task_id, message) {
                self.journal_active_goal_turn(task_id, self.active_codex_turn(task_id).as_ref());
            }
            let mut changed = false;
            let link = self.store.update_task(task_id, |link| {
                let Some(mut state) = native_execution_state(link) else {
                    return;
                };
                if state.native_sequence >= message.sequence() {
                    return;
                }
                if state.phase == NativeExecutionPhase::Continuing
                    && link.goal_status.as_deref() != Some("active")
                {
                    state.phase = NativeExecutionPhase::Idle;
                    state.execution_outcome = state.outcome.clone();
                }
                state.revision = next_runtime_event_sequence().to_string();
                state.native_sequence = message.sequence();
                state.updated_at = now_ms();
                project_native_execution(link, &state);
                changed = true;
            });
            if let Some(link) = link.filter(|_| changed) {
                self.publish_native_execution(task_id, request, link);
            }
            return;
        }
        if !matches!(
            notification.method.as_str(),
            "turn/started" | "turn/completed"
        ) || !is_root_codex_turn_event(notification.params)
        {
            return;
        }
        let result = self.persist_completed_codex_turn_from_notification(task_id, message);
        let Some(turn_id) = codex_notification_turn_id(message) else {
            return;
        };
        let thread_id = codex_notification_thread_id(message);
        let started = notification.method == "turn/started";
        let before = self
            .local_task_link(task_id)
            .and_then(|link| native_execution_state(&link));
        let owned_turn =
            before.as_ref().and_then(|state| state.turn_id.as_deref()) == Some(turn_id.as_str());
        log_executor_event(
            "runtime native turn boundary applying",
            &[
                ("local_task_id", task_id.to_owned()),
                ("method", notification.method.clone()),
                ("turn_id", turn_id.clone()),
                ("native_sequence", message.sequence().to_string()),
                (
                    "process_generation",
                    message.process_generation().to_string(),
                ),
                (
                    "previous_turn_id",
                    before
                        .as_ref()
                        .and_then(|state| state.latest_turn_id.clone())
                        .unwrap_or_default(),
                ),
                (
                    "previous_native_sequence",
                    before
                        .as_ref()
                        .map_or(0, |state| state.native_sequence)
                        .to_string(),
                ),
            ],
        );
        let mut changed = false;
        let updated = self.store.update_task(task_id, |link| {
            if thread_id.is_some() && thread_id != link.thread_id {
                return;
            }
            let previous = native_execution_state(link);
            if previous
                .as_ref()
                .is_some_and(|state| state.native_sequence >= message.sequence())
            {
                return;
            }
            if !started
                && previous.as_ref().is_some_and(|state| {
                    state.turn_id.as_ref().is_some_and(|id| id != &turn_id)
                        || (state.latest_turn_id.as_ref() == Some(&turn_id)
                            && state.outcome.is_some())
                })
            {
                return;
            }
            if started
                && previous
                    .as_ref()
                    .is_some_and(|state| state.latest_turn_id.as_ref() == Some(&turn_id))
            {
                return;
            }
            let turn = notification
                .params
                .get("turn")
                .unwrap_or(notification.params);
            let outcome = (!started).then(|| {
                match turn["status"].as_str() {
                    Some("failed") => "failed",
                    Some("interrupted" | "cancelled") => "cancelled",
                    _ => "succeeded",
                }
                .to_owned()
            });
            let continuing = !started
                && outcome.as_deref() == Some("succeeded")
                && link.goal_status.as_deref() == Some("active");
            let state = NativeExecutionState {
                revision: next_runtime_event_sequence().to_string(),
                epoch: native_execution_epoch().to_owned(),
                updated_at: now_ms(),
                native_sequence: message.sequence(),
                process_generation: Some(message.process_generation()),
                phase: if started {
                    NativeExecutionPhase::Running
                } else if continuing {
                    NativeExecutionPhase::Continuing
                } else {
                    NativeExecutionPhase::Idle
                },
                turn_id: started.then(|| turn_id.clone()),
                latest_turn_id: Some(turn_id.clone()),
                execution_outcome: if started || continuing {
                    None
                } else {
                    outcome.clone()
                },
                outcome,
                request_turn_id: previous
                    .as_ref()
                    .and_then(|state| state.request_turn_id.clone())
                    .or_else(|| Some(turn_id.clone())),
                continuation: previous
                    .as_ref()
                    .and_then(|state| state.request_turn_id.as_deref())
                    .is_some_and(|id| id != turn_id)
                    && link.goal_status.as_deref() == Some("active"),
                started_at: timestamp_ms_field(turn, "startedAt").or_else(|| {
                    (!started)
                        .then(|| previous.as_ref().and_then(|state| state.started_at))
                        .flatten()
                }),
                completed_at: (!started)
                    .then(|| timestamp_ms_field(turn, "completedAt"))
                    .flatten(),
                duration_ms: turn.get("durationMs").and_then(Value::as_i64),
                error: turn
                    .get("error")
                    .and_then(|error| string_field(error, "message")),
            };
            project_native_execution(link, &state);
            changed = true;
        });
        let Some(link) = updated.filter(|_| changed) else {
            return;
        };
        let terminal_snapshot = owned_turn.then(|| link.clone());
        self.publish_native_execution(task_id, request, link);
        if let (Some(result), Some(snapshot)) = (result, terminal_snapshot) {
            let event_request = self.request_for_codex_event(task_id, request, Some(&turn_id));
            self.publish_native_turn_result(task_id, &event_request, &turn_id, snapshot, result);
        }
    }

    fn publish_native_turn_result(
        &self,
        task_id: &str,
        request: &ExecutionRequest,
        turn_id: &str,
        snapshot: RuntimeTaskLink,
        result: crate::agents::CodexAppServerTurn,
    ) {
        let mut data = json!({"turnId": turn_id, "itemId": result.response_item_id,
            "startedAt": result.started_at_ms, "completedAt": result.completed_at_ms,
            "durationMs": result.duration_ms});
        let event = match result.outcome {
            ExecutionOutcome::Completed { content } => {
                data["value"] = json!(content);
                data["valueOrigin"] = json!(result.response_value_origin.as_str());
                "response.completed"
            }
            ExecutionOutcome::Failed { message } => {
                data["error"] = json!({"message": message});
                "response.failed"
            }
            ExecutionOutcome::Cancelled { message } => {
                data["type"] = json!("cancelled");
                data["error"] = json!({"message": message});
                "response.incomplete"
            }
            _ => return,
        };
        data["task"] = local_task_json(snapshot);
        emit_response_event(
            &self.event_tx,
            &self.device_id,
            event,
            task_id,
            request,
            data,
        );
    }

    fn apply_native_recovery(
        &self,
        task_id: &str,
        request: &ExecutionRequest,
        message: &CodexNotification,
    ) {
        let turn_id = codex_notification_turn_id(message);
        let mut changed = false;
        let updated = self.store.update_task(task_id, |link| {
            let Some(mut state) = native_execution_state(link) else {
                return;
            };
            if state.native_sequence >= message.sequence()
                || state.latest_turn_id != turn_id
                || state.turn_id.is_some()
                || state.outcome.as_deref() != Some("failed")
                || state.process_generation != Some(message.process_generation())
            {
                return;
            }
            state.phase = NativeExecutionPhase::Recovering;
            state.execution_outcome = None;
            state.updated_at = now_ms();
            state.revision = next_runtime_event_sequence().to_string();
            state.native_sequence = message.sequence();
            project_native_execution(link, &state);
            changed = true;
        });
        if let Some(link) = updated.filter(|_| changed) {
            self.publish_native_execution(task_id, request, link);
            let mut event_request = request.clone();
            if let Some(turn_id) = &turn_id {
                event_request.subtask_id = turn_id.clone();
            }
            self.emit_task_response(
                "response.recovered",
                task_id,
                &event_request,
                json!({"turnId": turn_id}),
            );
        }
    }

    fn publish_native_execution(
        &self,
        task_id: &str,
        request: &ExecutionRequest,
        link: RuntimeTaskLink,
    ) {
        let Some(state) = native_execution_state(&link) else {
            return;
        };
        self.project_runtime_link_status_now(&link);
        let turn_id = state.latest_turn_id.clone();
        let event_request = self.request_for_codex_event(task_id, request, turn_id.as_deref());
        emit_response_event(
            &self.event_tx,
            &self.device_id,
            "runtime.turn.updated",
            task_id,
            &event_request,
            json!({
                "status": if state.turn_id.is_some() { "started" } else { "settled" },
                "threadId": link.thread_id,
                "turnId": turn_id,
                "task": local_task_json(link),
            }),
        );
    }
}

#[cfg(test)]
mod publication_tests {
    use super::*;

    #[test]
    fn next_admission_cannot_change_the_snapshot_bound_to_a_completed_turn_result() {
        let directory = tempfile::tempdir().unwrap();
        let (events, mut receiver) = broadcast::channel(16);
        let mut handler = RuntimeWorkRpcHandler::with_event_sender("device", "/bin/false", events);
        handler.store = RuntimeWorkStore::new(directory.path().join("index.json"));
        let mut link =
            RuntimeTaskLink::new_pending("task".into(), "/project".into(), "Task".into());
        link.thread_id = Some("thread".into());
        handler.upsert_local_task(link);
        let request = ExecutionRequest {
            task_id: "task".into(),
            subtask_id: "turn".into(),
            ..Default::default()
        };
        for method in ["turn/started", "turn/completed"] {
            handler.apply_native_lifecycle(
                "task",
                &request,
                &json!({"method": method, "params": {
                    "threadId": "thread", "turn": {"id": "turn", "status": "completed"}
                }})
                .into(),
            );
        }
        while receiver.try_recv().is_ok() {}
        let snapshot = handler.local_task_link("task").unwrap();
        handler.store.update_task("task", begin_native_request);
        let result = crate::agents::completed_native_codex_turn(
            "thread",
            &json!({
                "id": "turn", "status": "completed", "items": [{
                    "id": "text", "type": "agentMessage", "text": "First result", "phase": "final_answer"
                }]
            }),
        );
        handler.publish_native_turn_result("task", &request, "turn", snapshot, result);
        let event = receiver.try_recv().unwrap();
        assert_eq!(event["payload"]["data"]["value"], "First result");
        assert_eq!(
            event["payload"]["data"]["task"]["executionState"]["outcome"],
            "succeeded"
        );
        assert_eq!(
            handler
                .local_task_link("task")
                .unwrap()
                .execution_state
                .unwrap()
                .phase,
            NativeExecutionPhase::Starting
        );
    }
}
