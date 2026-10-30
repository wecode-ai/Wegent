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
        current: Vec<String>,
    ) {
        let active = self
            .turn_scheduler
            .lock()
            .expect("runtime turn scheduler lock should not be poisoned")
            .active_task_ids
            .clone();
        let mut positions = HashMap::new();
        for (position, task_id) in current.into_iter().enumerate() {
            positions.entry(task_id.clone()).or_insert(position);
            previous.insert(task_id);
        }
        for task_id in previous {
            let mut changed = false;
            self.store.update_task(&task_id, |link| {
                let before = native_execution_state(link);
                if active.contains(&task_id) {
                    if before
                        .as_ref()
                        .is_some_and(|state| state.phase == NativeExecutionPhase::Queued)
                    {
                        begin_native_request(link);
                    }
                } else if let Some(position) = positions.get(&task_id) {
                    queue_native_execution(link, *position);
                } else if before
                    .as_ref()
                    .is_some_and(|state| state.phase == NativeExecutionPhase::Queued)
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

    pub(super) fn settle_native_transport_exit(&self) {
        for task in self.local_task_links(true) {
            if !native_execution_state(&task).is_some_and(|state| {
                !matches!(
                    state.phase,
                    NativeExecutionPhase::Idle | NativeExecutionPhase::Queued
                )
            }) {
                continue;
            }
            if let Some(link) = self.store.update_task(&task.local_task_id, |link| {
                settle_native_execution(link, "cancelled");
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
        if !is_root_codex_turn_event(notification.params)
            || self.local_task_link(task_id).is_some_and(|link| {
                codex_notification_thread_id(message)
                    .is_some_and(|thread| link.thread_id.as_deref() != Some(thread.as_str()))
            })
        {
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
        self.persist_completed_codex_turn_from_notification(task_id, message);
        let Some(turn_id) = codex_notification_turn_id(message) else {
            return;
        };
        let thread_id = codex_notification_thread_id(message);
        let started = notification.method == "turn/started";
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
        self.publish_native_execution(task_id, request, link);
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
        let mut event_request = request.clone();
        if let Some(turn_id) = &turn_id {
            event_request.subtask_id = turn_id.clone();
        }
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
