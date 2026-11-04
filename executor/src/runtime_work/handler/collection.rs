// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

mod catalog;

const ACTIVE_TURN_STOP_POLL_INTERVAL: Duration = Duration::from_millis(10);

enum ActiveTurnStopState {
    Missing,
    Pending,
    Stopped,
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

impl RuntimeWorkRpcHandler {
    pub(super) async fn task_link_from_payload(
        &self,
        payload: &Value,
        archived: bool,
    ) -> Result<RuntimeTaskLink, AppIpcError> {
        let local_task_id = runtime_task_id(payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        if let Some(link) = self.local_task_link(&local_task_id) {
            if (link.status == "archived") == archived {
                log_runtime_archive_link(
                    "runtime task payload matched local link",
                    &link,
                    archived,
                );
                return Ok(link);
            }
            log_runtime_archive_link(
                "runtime task payload skipped local link status mismatch",
                &link,
                archived,
            );
        }

        for link in self.collect_links(archived).await {
            if link.local_task_id == local_task_id
                || link.thread_id.as_deref() == Some(local_task_id.as_str())
            {
                log_runtime_archive_link(
                    "runtime task payload matched collected link",
                    &link,
                    archived,
                );
                return Ok(link);
            }
        }

        let workspace_path = workspace_path(payload)
            .ok_or_else(|| AppIpcError::new("not_found", "runtime task was not found"))?;
        // A local task ID identifies Wework's persisted task record; it is not a
        // Codex thread ID. Keep this unresolved until a provider thread is known.
        let mut link =
            RuntimeTaskLink::new_pending(local_task_id.clone(), workspace_path, local_task_id);
        link.status = if archived { "archived" } else { "active" }.to_owned();
        link.running = false;
        link.continuable = !archived;
        log_runtime_archive_link("runtime task payload created pending link", &link, archived);
        Ok(link)
    }

    pub(super) async fn recover_send_task_link(
        &self,
        payload: &Value,
        local_task_id: &str,
        existing_link: Option<&RuntimeTaskLink>,
    ) -> Option<RuntimeTaskLink> {
        if existing_link
            .and_then(runtime_session_id_from_link)
            .is_some()
        {
            return existing_link.cloned();
        }

        let workspace_path = workspace_path(payload).unwrap_or_default();
        let mut workspace_matches = Vec::new();
        for link in self.collect_links(false).await {
            if link.local_task_id == local_task_id
                || link.thread_id.as_deref() == Some(local_task_id)
            {
                return Some(link);
            }

            if !workspace_path.is_empty()
                && link.workspace_path == workspace_path
                && runtime_session_id_from_link(&link).is_some()
            {
                workspace_matches.push(link);
            }
        }

        if workspace_matches.len() == 1 {
            workspace_matches.pop()
        } else {
            None
        }
    }

    pub(super) async fn thread_messages(&self, thread_id: &str) -> Vec<Value> {
        match load_codex_transcript(
            &self.codex_app_server,
            CodexTranscriptRequest {
                thread_id,
                cursor: None,
                limit: CODEX_TRANSCRIPT_PAGE_SIZE,
                direction: CodexTranscriptDirection::Descending,
                full_content: true,
                prefer_rollout_history: false,
            },
        )
        .await
        {
            Ok(page) => transcript_messages(&page.thread, &self.device_id),
            Err(error) => {
                eprintln!("failed to read Codex app-server thread {thread_id}: {error}");
                Vec::new()
            }
        }
    }

    pub(super) async fn call_codex_thread_method(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let result = self
            .call_codex_thread_method_without_list_invalidation(method, params)
            .await;
        result
    }

    pub(super) async fn call_codex_thread_method_without_list_invalidation(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        if let Some(thread_id) = codex_stream_thread_id(&params) {
            self.register_thread_event_route_from_store(&thread_id);
        }
        self.ensure_notification_router().await;
        match method {
            "thread/goal/set" | "thread/goal/clear" => {
                self.codex_app_server
                    .mutate_thread_goal(method, params)
                    .await
            }
            _ => self.codex_app_server.request(method, params).await,
        }
    }

    pub(super) fn link_from_thread(&self, thread: &Value) -> Option<RuntimeTaskLink> {
        let thread_id = string_field(thread, "id")?;
        let local_link = self.local_task_by_thread_id(&thread_id);
        let local_active = local_link
            .as_ref()
            .is_some_and(|link| self.is_active_local_task(&link.local_task_id));
        let queue_position = local_link
            .as_ref()
            .and_then(|link| self.queued_local_task_position(&link.local_task_id));
        let workspace_path = local_link
            .as_ref()
            .map(|link| link.workspace_path.clone())
            .filter(|path| !path.trim().is_empty())
            .or_else(|| string_field(thread, "cwd"))
            .unwrap_or_else(|| "~/.codex".to_owned());
        let mut link =
            RuntimeTaskLink::from_thread_metadata(thread, local_link, workspace_path, local_active);
        if queue_position.is_some() {
            apply_local_execution_state(&mut link, local_active, queue_position);
        }
        if let Some(path) = string_field(thread, "path") {
            let mut runtime_handle = link
                .runtime_handle
                .as_object()
                .cloned()
                .unwrap_or_else(Map::new);
            runtime_handle.insert("threadPath".to_owned(), Value::String(path));
            link.runtime_handle = Value::Object(runtime_handle);
        }
        Some(link)
    }

    pub(super) fn local_task_links(&self, include_archived: bool) -> Vec<RuntimeTaskLink> {
        self.store.list_task_summaries(include_archived)
    }

    pub(super) fn local_task_link(&self, local_task_id: &str) -> Option<RuntimeTaskLink> {
        self.store.get_task(local_task_id)
    }

    pub(super) fn archived_link_is_deleted(&self, link: &RuntimeTaskLink) -> bool {
        self.store.is_deleted_archived_task_id(&link.local_task_id)
            || link
                .thread_id
                .as_deref()
                .is_some_and(|thread_id| self.store.is_deleted_archived_task_id(thread_id))
    }

    pub(super) fn mark_archived_link_deleted(&self, link: &RuntimeTaskLink) {
        let mut ids = vec![link.local_task_id.clone()];
        if let Some(thread_id) = &link.thread_id {
            ids.push(thread_id.clone());
        }
        self.store.mark_deleted_archived_task_ids(ids);
    }

    pub(super) async fn archived_cleanup_links(
        &self,
        payload: &Value,
    ) -> Result<Vec<RuntimeTaskLink>, AppIpcError> {
        let items = payload
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if items.is_empty() {
            return Ok(self.collect_links(true).await);
        }

        let mut links = Vec::new();
        let mut seen = HashSet::new();
        for item in items {
            let local_task_id = runtime_task_id(&item)
                .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
            let payload_thread_id = runtime_session_id_from_payload(&item);
            let link = archived_link_from_payload_item(&item, local_task_id, payload_thread_id);
            if seen.insert(link.local_task_id.clone()) {
                links.push(link);
            }
        }
        Ok(links)
    }

    pub(super) fn local_task_by_thread_id(&self, thread_id: &str) -> Option<RuntimeTaskLink> {
        self.store.find_summary_by_thread_id(thread_id)
    }

    pub(super) fn task_send_gate(&self, local_task_id: &str) -> Arc<AsyncMutex<()>> {
        let mut gates = self
            .task_send_gates
            .lock()
            .expect("task send gate map lock should not be poisoned");
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = gates.get(local_task_id).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Arc::new(AsyncMutex::new(()));
        gates.insert(local_task_id.to_owned(), Arc::downgrade(&gate));
        gate
    }

    pub(super) fn upsert_local_task(&self, link: RuntimeTaskLink) {
        self.project_runtime_link_status(&link);
        self.store.upsert_task(link);
    }

    pub(super) fn running_task_count(&self) -> Value {
        let running_count = self
            .active_local_executions
            .lock()
            .expect("active local execution map lock should not be poisoned")
            .len();
        json!({
            "success": true,
            "runningCount": running_count,
        })
    }

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
        self.store.update_task(local_task_id, |link| {
            if thread_id.is_some() {
                link.thread_id = thread_id;
            }
            link.updated_at = now_ms();
            link.completed_at = Some(link.updated_at);
            link.status = status.to_owned();
            link.interaction_status = None;
            crate::runtime_work::lifecycle::settle_native_execution(
                link,
                if status == "failed" {
                    "failed"
                } else {
                    "cancelled"
                },
            );
            apply_local_execution_state(link, false, None);
            if link.thread_id.is_some() {
                clear_runtime_handle_messages(&mut link.runtime_handle);
            }
        });
        if let Some(link) = self.local_task_link(local_task_id) {
            self.project_runtime_link_status_now(&link);
        }
        self.schedule_worktree_prune();
        log_executor_event(
            "runtime work local execution force settled",
            &[
                ("local_task_id", local_task_id.to_owned()),
                ("status", status.to_owned()),
                ("reason", reason.to_owned()),
            ],
        );
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
        self.schedule_worktree_prune();
        true
    }

    pub(super) fn fail_local_task_execution_start(&self, local_task_id: &str, error: &AppIpcError) {
        self.store
            .update_task(local_task_id, |link| apply_local_task_failure(link, error));
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

    pub(super) async fn wait_for_active_codex_turn(
        &self,
        local_task_id: &str,
    ) -> Option<ActiveCodexTurn> {
        for attempt in 0..=ACTIVE_CODEX_TURN_WAIT_ATTEMPTS {
            if let Some(turn) = self.active_codex_turn(local_task_id) {
                return Some(turn);
            }
            if !self.is_active_local_task(local_task_id)
                || attempt == ACTIVE_CODEX_TURN_WAIT_ATTEMPTS
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
            self.project_runtime_link_status_now(&link);
        }
        if status != "running" {
            self.schedule_worktree_prune();
        }
        true
    }

    pub(super) fn sync_runtime_task_goal_from_notification(
        &self,
        local_task_id: &str,
        message: &Value,
    ) -> bool {
        let notification = codex_notification(message);
        let goal_status = match notification.method.as_str() {
            "thread/goal/updated" => notification
                .params
                .get("goal")
                .and_then(|goal| string_field(goal, "status")),
            "thread/goal/cleared" => None,
            _ => return false,
        };
        let goal_is_active = goal_status.as_deref() == Some("active");
        self.sync_runtime_task_goal_status(local_task_id, goal_status);
        goal_is_active
    }

    pub(super) fn sync_runtime_task_goal_status(
        &self,
        local_task_id: &str,
        goal_status: Option<String>,
    ) {
        self.update_runtime_task_goal_status(local_task_id, goal_status, true);
    }

    pub(super) fn hydrate_runtime_task_goal_status(
        &self,
        local_task_id: &str,
        goal_status: Option<String>,
    ) {
        self.update_runtime_task_goal_status(local_task_id, goal_status, false);
    }

    fn update_runtime_task_goal_status(
        &self,
        local_task_id: &str,
        goal_status: Option<String>,
        update_activity_time: bool,
    ) {
        let goal_is_active = goal_status.as_deref() == Some("active");
        self.store.update_task(local_task_id, |link| {
            if link.goal_status == goal_status {
                return;
            }
            link.goal_status = goal_status;
            if update_activity_time {
                link.updated_at = now_ms();
            }
        });
        if !goal_is_active {
            self.clear_active_goal_turn(local_task_id);
        }
    }
}
