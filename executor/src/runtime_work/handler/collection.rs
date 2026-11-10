// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

mod catalog;

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
                bounded_items: false,
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

    pub(super) fn mark_archived_link_deleted(&self, link: &RuntimeTaskLink) -> std::io::Result<()> {
        let mut ids = vec![link.local_task_id.clone()];
        if let Some(thread_id) = &link.thread_id {
            ids.push(thread_id.clone());
        }
        self.store.mark_deleted_archived_task_ids(ids)
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
