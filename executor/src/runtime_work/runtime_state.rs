// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::handler_helpers::*;
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn cached_codex_thread_for_transcript(&self, thread_id: &str) -> Option<Value> {
        self.thread_list_cache
            .find_thread(thread_id)
            .filter(thread_has_readable_rollout_path)
    }

    pub(super) fn incremental_cached_transcript(
        &self,
        cached: CachedTranscript,
        thread: &Value,
        local_link: Option<&RuntimeTaskLink>,
        running_hint: bool,
        workspace_path: &str,
    ) -> Option<CachedTranscript> {
        let previous_signature = cached.source_signature.as_ref()?;
        if string_field(thread, "path").as_deref() != Some(previous_signature.path()) {
            return None;
        }
        let current_signature = TranscriptSourceSignature::from_path(previous_signature.path())?;
        if current_signature.len() < previous_signature.len()
            || (current_signature.len() == previous_signature.len()
                && current_signature != *previous_signature)
        {
            return None;
        }
        let turns = cached.rollout_turns?;
        let append = append_rollout_turns_from_offset(thread, turns, previous_signature.len())?;
        let updated_thread = thread_with_turns(thread, append.turns.clone());
        let context_usage = transcript_context_usage(&updated_thread).or(cached.context_usage);
        let messages = local_link
            .map(|link| {
                merge_cached_messages(
                    append_changed_transcript_messages(
                        cached.messages.clone(),
                        thread,
                        &append.turns,
                        append.changed_start,
                        &self.device_id,
                    ),
                    cached_runtime_transcript_messages(link),
                )
            })
            .unwrap_or_else(|| {
                append_changed_transcript_messages(
                    cached.messages,
                    thread,
                    &append.turns,
                    append.changed_start,
                    &self.device_id,
                )
            });
        let running = transcript_running(local_link, running_hint, &messages);
        Some(
            CachedTranscript::new(
                workspace_path.to_owned(),
                "codex".to_owned(),
                messages,
                running,
                Some(current_signature),
            )
            .with_context_usage(context_usage)
            .with_rollout_turns(Some(append.turns)),
        )
    }

    pub(super) async fn call_codex_thread_method(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let result = self
            .call_codex_thread_method_without_list_invalidation(method, params)
            .await;
        if result.is_ok() {
            self.thread_list_cache.invalidate();
        }
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
        self.codex_app_server.request(method, params).await
    }

    pub(super) fn link_from_thread(&self, thread: &Value) -> Option<RuntimeTaskLink> {
        let thread_id = string_field(thread, "id")?;
        let mut local_link = self.local_task_by_thread_id(&thread_id);
        let local_active = local_link
            .as_ref()
            .is_some_and(|link| self.is_active_local_task(&link.local_task_id));
        if let Some(link) = &mut local_link {
            if !local_active && normalize_inactive_running_codex_task(link) {
                self.store.upsert_task(link.clone());
            }
        }
        let workspace_path = string_field(thread, "cwd")
            .or_else(|| local_link.as_ref().map(|link| link.workspace_path.clone()))
            .unwrap_or_else(|| "~/.codex".to_owned());
        let mut link = RuntimeTaskLink::from_thread_metadata(thread, local_link, workspace_path);
        if let Some(path) = string_field(thread, "path") {
            let mut runtime_handle = link
                .runtime_handle
                .as_object()
                .cloned()
                .unwrap_or_else(Map::new);
            runtime_handle.insert("threadPath".to_owned(), Value::String(path));
            link.runtime_handle = Value::Object(runtime_handle);
        }
        if local_active {
            link.status = "running".to_owned();
            link.running = true;
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
        self.thread_list_cache.invalidate();
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
            let active_links = self.collect_links(false).await;
            let archived_links = self.collect_links(true).await;
            let protected_worktree_dirs = active_links
                .iter()
                .chain(archived_links.iter())
                .filter_map(|link| managed_worktree_container(&link.workspace_path))
                .collect::<HashSet<_>>();
            let mut links = archived_links;
            links.extend(orphaned_managed_worktree_links(
                &protected_worktree_dirs,
                &managed_worktree_roots(),
            ));
            return Ok(links);
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

    pub(super) fn upsert_local_task(&self, link: RuntimeTaskLink) {
        self.store.upsert_task(link);
        self.thread_list_cache.invalidate();
    }

    pub(super) fn mark_active_local_task(&self, local_task_id: &str) {
        self.active_local_tasks
            .lock()
            .expect("active local task set lock should not be poisoned")
            .insert(local_task_id.to_owned());
    }

    pub(super) fn unmark_active_local_task(&self, local_task_id: &str) {
        self.active_local_tasks
            .lock()
            .expect("active local task set lock should not be poisoned")
            .remove(local_task_id);
    }

    pub(super) fn set_active_turn_cancellation(
        &self,
        local_task_id: String,
        control: ActiveTurnCancellation,
    ) {
        if let Some(previous) = self
            .active_turn_cancellations
            .lock()
            .expect("active turn cancellation map lock should not be poisoned")
            .insert(local_task_id, control)
        {
            let _ = previous.cancel.send(());
        }
    }

    pub(super) fn clear_active_turn_cancellation(&self, local_task_id: &str) {
        self.active_turn_cancellations
            .lock()
            .expect("active turn cancellation map lock should not be poisoned")
            .remove(local_task_id);
    }

    pub(super) fn record_active_codex_turn(
        &self,
        local_task_id: &str,
        thread_id: String,
        turn_id: String,
    ) {
        self.active_codex_turns
            .lock()
            .expect("active codex turn map lock should not be poisoned")
            .insert(
                local_task_id.to_owned(),
                ActiveCodexTurn { thread_id, turn_id },
            );
    }

    pub(super) fn active_codex_turn(&self, local_task_id: &str) -> Option<ActiveCodexTurn> {
        self.active_codex_turns
            .lock()
            .expect("active codex turn map lock should not be poisoned")
            .get(local_task_id)
            .cloned()
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

    pub(super) fn clear_active_codex_turn(&self, local_task_id: &str) {
        self.active_codex_turns
            .lock()
            .expect("active codex turn map lock should not be poisoned")
            .remove(local_task_id);
    }

    pub(super) async fn abort_active_turn(&self, local_task_id: &str) -> bool {
        let control = {
            self.active_turn_cancellations
                .lock()
                .expect("active turn cancellation map lock should not be poisoned")
                .remove(local_task_id)
        };
        if let Some(control) = control {
            let _ = control.cancel.send(());
            let stopped =
                tokio::time::timeout(std::time::Duration::from_secs(10), control.stopped).await;
            if stopped.is_err() {
                return false;
            }
        }
        self.clear_active_codex_turn(local_task_id);
        self.unmark_active_local_task(local_task_id);
        true
    }

    pub(super) fn is_active_local_task(&self, local_task_id: &str) -> bool {
        self.active_local_tasks
            .lock()
            .expect("active local task set lock should not be poisoned")
            .contains(local_task_id)
    }

    pub(super) fn finish_local_task(
        &self,
        local_task_id: &str,
        thread_id: Option<String>,
        status: &str,
    ) {
        self.clear_active_turn_cancellation(local_task_id);
        let invalidate_thread_id = thread_id.clone();
        self.store.update_task(local_task_id, |link| {
            if thread_id.is_some() {
                link.thread_id = thread_id;
            }
            link.status = status.to_owned();
            link.running = status == "running";
            link.updated_at = now_ms();
            if link.thread_id.is_some() && status != "running" {
                retain_runtime_handle_user_messages(&mut link.runtime_handle);
            }
        });
        self.transcript_cache.invalidate(local_task_id);
        if let Some(thread_id) = invalidate_thread_id {
            self.transcript_cache.invalidate(&thread_id);
        }
        if status != "running" {
            self.unmark_active_local_task(local_task_id);
        }
        self.thread_list_cache.invalidate();
    }
}
