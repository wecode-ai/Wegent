// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

const ACTIVE_TURN_STOP_POLL_INTERVAL: Duration = Duration::from_millis(10);

enum ActiveTurnStopState {
    Missing,
    Pending,
    Stopped,
}

pub(super) struct LocalExecutionReconciliationGuard {
    execution_id: Option<u64>,
    codex_turn_id: Option<String>,
    native_revision: Option<String>,
    native_turn_id: Option<String>,
    thread_id: Option<String>,
}

fn request_execution_stop(control: &mut ActiveLocalExecution) {
    if control.stop_requested {
        return;
    }
    let (spent_cancel, spent_cancel_rx) = oneshot::channel();
    drop(spent_cancel_rx);
    let cancel = std::mem::replace(&mut control.cancel, spent_cancel);
    control.stop_requested = true;
    let _ = cancel.send(());
}

fn settle_local_execution_link(
    link: &mut RuntimeTaskLink,
    thread_id: Option<String>,
    status: &str,
) {
    if thread_id.is_some() {
        link.thread_id = thread_id;
    }
    link.updated_at = now_ms();
    link.completed_at = Some(link.updated_at);
    link.status = status.to_owned();
    link.interaction_status = None;
    crate::runtime_work::lifecycle::settle_native_execution(
        link,
        match status {
            "done" => "succeeded",
            "failed" => "failed",
            _ => "cancelled",
        },
    );
    apply_local_execution_state(link, false, None);
    if link.thread_id.is_some() {
        clear_runtime_handle_messages(&mut link.runtime_handle);
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) fn start_local_task_execution(
        &self,
        local_task_id: String,
        cancel: oneshot::Sender<()>,
        stopped: oneshot::Receiver<()>,
    ) -> u64 {
        let execution_id = self.next_execution_id.fetch_add(1, Ordering::Relaxed);
        let control = ActiveLocalExecution {
            execution_id,
            request: None,
            stop_requested: false,
            stop_acknowledged: false,
            cancel,
            stopped,
            codex_turn: None,
        };
        if let Some(previous) = self
            .active_local_executions
            .lock()
            .expect("active local execution map lock should not be poisoned")
            .insert(local_task_id.clone(), control)
        {
            let _ = previous.cancel.send(());
        }
        self.store.update_task(&local_task_id, |link| {
            crate::runtime_work::lifecycle::begin_native_request(link);
            apply_local_execution_state(link, true, None);
            let started_at = now_ms().max(link.updated_at.max(link.recency_at).saturating_add(1));
            link.updated_at = started_at;
            link.recency_at = started_at;
            link.completed_at = None;
        });
        if let Some(link) = self.local_task_link(&local_task_id) {
            self.project_runtime_link_status_now(&link);
        }
        execution_id
    }

    pub(super) fn finish_local_task_execution(
        &self,
        local_task_id: &str,
        execution_id: u64,
    ) -> bool {
        {
            let mut active = self
                .active_local_executions
                .lock()
                .expect("active local execution map lock should not be poisoned");
            let Some(control) = active.get(local_task_id) else {
                return false;
            };
            if control.execution_id != execution_id {
                return false;
            }
            active.remove(local_task_id);
        }
        true
    }

    pub(super) fn is_current_local_task_execution(
        &self,
        local_task_id: &str,
        execution_id: u64,
    ) -> bool {
        self.active_local_executions
            .lock()
            .expect("active local execution map lock should not be poisoned")
            .get(local_task_id)
            .is_some_and(|control| control.execution_id == execution_id)
    }

    pub(super) fn is_local_task_execution_accepting_notifications(
        &self,
        local_task_id: &str,
        execution_id: u64,
    ) -> bool {
        self.active_local_executions
            .lock()
            .expect("active local execution map lock should not be poisoned")
            .get(local_task_id)
            .is_some_and(|control| control.execution_id == execution_id && !control.stop_requested)
    }

    pub(super) fn request_active_turn_stop(&self, local_task_id: &str) -> bool {
        let mut active = self
            .active_local_executions
            .lock()
            .expect("active local execution map lock should not be poisoned");
        let Some(control) = active.get_mut(local_task_id) else {
            return false;
        };
        request_execution_stop(control);
        true
    }

    pub(super) fn force_settle_local_task_execution(
        &self,
        local_task_id: &str,
        thread_id: Option<String>,
        status: &str,
        reason: &str,
    ) -> bool {
        {
            let mut active = self
                .active_local_executions
                .lock()
                .expect("active local execution map lock should not be poisoned");
            let Some(control) = active.get_mut(local_task_id) else {
                return false;
            };
            request_execution_stop(control);
            active.remove(local_task_id);
        }
        self.store
            .update_task_without_snapshot(local_task_id, |link| {
                settle_local_execution_link(link, thread_id, status);
            });
        self.publish_settled_local_execution(local_task_id, status, reason);
        true
    }

    fn publish_settled_local_execution(&self, local_task_id: &str, status: &str, reason: &str) {
        if let Some(link) = self.store.get_task_summary(local_task_id) {
            if let Some(state) = crate::runtime_work::lifecycle::native_execution_state(&link) {
                self.release_settled_native_capacity(local_task_id, &state);
            }
            self.project_runtime_link_status_now(&link);
        }
        self.record_stand_in_completion_outbox(local_task_id, status);
        self.schedule_worktree_prune();
        log_executor_event(
            "runtime work local execution force settled",
            &[
                ("local_task_id", local_task_id.to_owned()),
                ("status", status.to_owned()),
                ("reason", reason.to_owned()),
            ],
        );
    }

    pub(super) fn local_execution_reconciliation_guard(
        &self,
        task_id: &str,
    ) -> Option<LocalExecutionReconciliationGuard> {
        let active = self.active_local_executions.lock().ok()?;
        let control = active.get(task_id);
        self.store
            .read_task(task_id, |link| LocalExecutionReconciliationGuard {
                execution_id: control.map(|control| control.execution_id),
                codex_turn_id: control
                    .and_then(|control| control.codex_turn.as_ref())
                    .map(|turn| turn.turn_id.clone()),
                native_revision: crate::runtime_work::lifecycle::native_execution_state(link)
                    .map(|state| state.revision),
                native_turn_id: crate::runtime_work::lifecycle::native_execution_state(link)
                    .and_then(|state| state.turn_id.or(state.latest_turn_id)),
                thread_id: link.thread_id.clone(),
            })
    }

    pub(super) fn reconcile_terminal_local_execution(
        &self,
        task_id: &str,
        thread_id: &str,
        status: &str,
        reason: &str,
        expected: &LocalExecutionReconciliationGuard,
        confirmed_turn_id: &str,
    ) -> bool {
        if expected
            .native_turn_id
            .as_deref()
            .is_some_and(|id| id != confirmed_turn_id)
            || expected
                .codex_turn_id
                .as_deref()
                .is_some_and(|id| id != confirmed_turn_id)
        {
            return false;
        }
        let mut active = self
            .active_local_executions
            .lock()
            .expect("active local execution map lock should not be poisoned");
        let control = active.get(task_id);
        if control.map(|control| control.execution_id) != expected.execution_id
            || control
                .and_then(|control| control.codex_turn.as_ref())
                .map(|turn| &turn.turn_id)
                != expected.codex_turn_id.as_ref()
        {
            return false;
        }
        let mut settled_status = None;
        self.store.update_task_without_snapshot(task_id, |link| {
            use crate::runtime_work::lifecycle::{
                native_execution_state, project_native_execution, NativeExecutionPhase,
            };
            let native = native_execution_state(link);
            let revision = native.as_ref().map(|state| state.revision.clone());
            if expected.thread_id.as_deref() != Some(thread_id)
                || link.thread_id != expected.thread_id
                || revision != expected.native_revision
            {
                return;
            }
            if let Some(state) = native.filter(|state| {
                state.phase == NativeExecutionPhase::Idle
                    && (state.execution_outcome.is_some() || state.outcome.is_some())
            }) {
                // Provider turn metadata cannot rewrite an authoritative execution outcome.
                project_native_execution(link, &state);
            } else {
                settle_local_execution_link(link, None, status);
            }
            settled_status = Some(link.status.clone());
        });
        let Some(settled_status) = settled_status else {
            return false;
        };
        if let Some(mut control) = active.remove(task_id) {
            request_execution_stop(&mut control);
        }
        drop(active);
        self.publish_settled_local_execution(task_id, &settled_status, reason);
        true
    }

    pub(super) fn settle_cancelled_local_task_execution(
        &self,
        local_task_id: &str,
        execution_id: u64,
    ) -> bool {
        {
            let mut active = self
                .active_local_executions
                .lock()
                .expect("active local execution map lock should not be poisoned");
            let Some(control) = active.get_mut(local_task_id) else {
                return false;
            };
            if control.execution_id != execution_id || !control.stop_requested {
                return false;
            }
            control.stop_acknowledged = true;
            active.remove(local_task_id);
        }
        self.store.update_task(local_task_id, |link| {
            link.updated_at = now_ms();
            link.completed_at = Some(link.updated_at);
            link.status = "cancelled".to_owned();
            link.interaction_status = None;
            crate::runtime_work::lifecycle::settle_native_execution(link, "cancelled");
            apply_local_execution_state(link, false, None);
        });
        if let Some(link) = self.local_task_link(local_task_id) {
            self.project_runtime_link_status_now(&link);
        }
        self.record_stand_in_completion_outbox(local_task_id, "cancelled");
        self.schedule_worktree_prune();
        true
    }

    pub(super) fn fail_local_task_execution_start(&self, local_task_id: &str, error: &AppIpcError) {
        self.store
            .update_task(local_task_id, |link| apply_local_task_failure(link, error));
        self.record_stand_in_completion_outbox(local_task_id, "failed");
        log_executor_event(
            "runtime work turn start failed",
            &[
                ("local_task_id", local_task_id.to_owned()),
                ("error", error.message.clone()),
            ],
        );
        let handler = self.clone();
        let local_task_id = local_task_id.to_owned();
        tokio::spawn(async move {
            handler.finish_scheduled_turn(&local_task_id).await;
        });
    }

    pub(super) fn record_active_codex_turn(
        &self,
        local_task_id: &str,
        execution_id: u64,
        thread_id: String,
        turn_id: String,
    ) {
        let mut active = self
            .active_local_executions
            .lock()
            .expect("active local execution map lock should not be poisoned");
        let Some(execution) = active.get_mut(local_task_id) else {
            return;
        };
        if execution.execution_id != execution_id {
            return;
        }
        execution.codex_turn = Some(ActiveCodexTurn {
            execution_id,
            thread_id,
            turn_id,
        });
    }

    pub(super) fn active_codex_turn(&self, local_task_id: &str) -> Option<ActiveCodexTurn> {
        self.active_local_executions
            .lock()
            .expect("active local execution map lock should not be poisoned")
            .get(local_task_id)
            .and_then(|execution| execution.codex_turn.clone())
    }

    pub(super) async fn wait_for_guidance_turn(
        &self,
        local_task_id: &str,
    ) -> Option<(String, String)> {
        use crate::runtime_work::lifecycle::{native_execution_state, NativeExecutionPhase};

        // Native Goal continuations outlive the local request's execution control.
        for attempt in 0..=ACTIVE_CODEX_TURN_WAIT_ATTEMPTS {
            let (phase, thread_id, turn_id) = self.store.read_task(local_task_id, |link| {
                if link.runtime != "codex" {
                    return None;
                }
                let state = native_execution_state(link)?;
                Some((state.phase, link.thread_id.clone(), state.turn_id))
            })??;
            if phase == NativeExecutionPhase::Running {
                return Some((thread_id?, turn_id?));
            }
            if !matches!(
                phase,
                NativeExecutionPhase::Starting | NativeExecutionPhase::Continuing
            ) || attempt == ACTIVE_CODEX_TURN_WAIT_ATTEMPTS
            {
                return None;
            }
            tokio::time::sleep(std::time::Duration::from_millis(ACTIVE_CODEX_TURN_WAIT_MS)).await;
        }
        None
    }

    pub(super) async fn wait_for_running_side_source_turn(&self, thread_id: &str) {
        let Some(source) = self.local_task_by_thread_id(thread_id) else {
            return;
        };
        if !self.is_active_local_task(&source.local_task_id)
            || self.active_codex_turn(&source.local_task_id).is_some()
        {
            return;
        }

        log_executor_event(
            "runtime side source turn awaiting",
            &[
                ("local_task_id", source.local_task_id.clone()),
                ("thread_id", thread_id.to_owned()),
            ],
        );
        while self.is_active_local_task(&source.local_task_id) {
            if self.active_codex_turn(&source.local_task_id).is_some() {
                log_executor_event(
                    "runtime side source turn ready",
                    &[
                        ("local_task_id", source.local_task_id),
                        ("thread_id", thread_id.to_owned()),
                    ],
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(ACTIVE_CODEX_TURN_WAIT_MS)).await;
        }
        log_executor_event(
            "runtime side source turn settled before start",
            &[
                ("local_task_id", source.local_task_id),
                ("thread_id", thread_id.to_owned()),
            ],
        );
    }

    pub(super) fn clear_active_codex_turn(&self, local_task_id: &str, execution_id: u64) {
        let mut active = self
            .active_local_executions
            .lock()
            .expect("active local execution map lock should not be poisoned");
        let Some(execution) = active.get_mut(local_task_id) else {
            return;
        };
        if execution
            .codex_turn
            .as_ref()
            .is_some_and(|turn| turn.execution_id == execution_id)
        {
            execution.codex_turn = None;
        }
    }

    pub(super) async fn abort_active_turn(&self, local_task_id: &str) -> bool {
        self.abort_active_turn_with_timeout(local_task_id, Duration::from_secs(10))
            .await
    }

    pub(super) async fn abort_active_turn_with_timeout(
        &self,
        local_task_id: &str,
        stop_timeout: Duration,
    ) -> bool {
        let deadline = Instant::now() + stop_timeout;
        loop {
            match self.poll_active_turn_stop(local_task_id) {
                ActiveTurnStopState::Missing | ActiveTurnStopState::Stopped => return true,
                ActiveTurnStopState::Pending => {}
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            tokio::time::sleep(
                ACTIVE_TURN_STOP_POLL_INTERVAL.min(deadline.saturating_duration_since(now)),
            )
            .await;
        }
    }

    fn poll_active_turn_stop(&self, local_task_id: &str) -> ActiveTurnStopState {
        let mut active = self
            .active_local_executions
            .lock()
            .expect("active local execution map lock should not be poisoned");
        let Some(control) = active.get_mut(local_task_id) else {
            return ActiveTurnStopState::Missing;
        };
        request_execution_stop(control);
        if !control.stop_acknowledged {
            control.stop_acknowledged = match control.stopped.try_recv() {
                Ok(()) => true,
                Err(oneshot::error::TryRecvError::Closed | oneshot::error::TryRecvError::Empty) => {
                    false
                }
            };
        }
        if control.stop_acknowledged {
            active.remove(local_task_id);
            ActiveTurnStopState::Stopped
        } else {
            ActiveTurnStopState::Pending
        }
    }

    pub(super) fn is_active_local_task(&self, local_task_id: &str) -> bool {
        self.active_local_executions
            .lock()
            .expect("active local execution map lock should not be poisoned")
            .contains_key(local_task_id)
    }

    pub(super) fn clear_active_request_user_input(&self, local_task_id: &str, execution_id: u64) {
        let mut active = self
            .active_request_user_inputs
            .lock()
            .expect("request user input map lock should not be poisoned");
        if active
            .get(local_task_id)
            .is_some_and(|request| request.execution_id == execution_id)
        {
            active.remove(local_task_id);
        }
    }

    pub(super) fn finish_local_task(
        &self,
        local_task_id: &str,
        execution_id: u64,
        thread_id: Option<String>,
        status: &str,
    ) -> bool {
        if !self.finish_local_task_execution(local_task_id, execution_id) {
            return false;
        }
        self.store.update_task(local_task_id, |link| {
            if thread_id.is_some() {
                link.thread_id = thread_id;
            }
            if let Some(state) = crate::runtime_work::lifecycle::native_execution_state(link) {
                if status == "done" || state.request_turn_id.is_some() {
                    crate::runtime_work::lifecycle::project_native_execution(link, &state);
                    return;
                }
            }
            if status != "running" {
                crate::runtime_work::lifecycle::settle_native_execution(
                    link,
                    match status {
                        "done" => "succeeded",
                        "failed" => "failed",
                        _ => "cancelled",
                    },
                );
            }
            link.updated_at = now_ms();
            if status != "running" {
                link.completed_at = Some(link.updated_at);
                link.status = status.to_owned();
                if status != "done"
                    || link.interaction_status.as_deref() != Some(INTERACTION_AWAITING_USER_REPLY)
                {
                    link.interaction_status = None;
                }
            }
            apply_local_execution_state(link, status == "running", None);
            if link.thread_id.is_some() {
                clear_runtime_handle_messages(&mut link.runtime_handle);
            }
        });
        if let Some(link) = self.local_task_link(local_task_id) {
            // The native turn may settle before this local execution unwinds, in
            // which case `publish_native_execution` skips the scheduler release
            // because the local execution was still registered. Whichever side
            // settles last must hand the slot back, otherwise queued turns stay
            // stranded behind a task that no longer runs anything.
            if let Some(state) = crate::runtime_work::lifecycle::native_execution_state(&link) {
                self.release_settled_native_capacity(local_task_id, &state);
            }
            self.project_runtime_link_status_now(&link);
        }
        if status != "running" {
            self.record_stand_in_completion_outbox(local_task_id, status);
            self.schedule_worktree_prune();
        }
        true
    }
}
