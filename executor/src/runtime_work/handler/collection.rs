// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn collect_links(&self, archived: bool) -> Vec<RuntimeTaskLink> {
        let started_at = Instant::now();
        let mut links = Vec::new();
        let mut discovered_thread_ids = HashSet::new();
        let mut discovered_local_task_ids = HashSet::new();

        let threads = self.codex_threads(archived).await;
        let stage_started_at = Instant::now();
        for thread in threads {
            let thread_started_at = Instant::now();
            let thread_id = string_field(&thread, "id").unwrap_or_else(|| "none".to_owned());
            if let Some(mut link) = self.link_from_thread(&thread) {
                log_slow_runtime_collect_thread(
                    archived,
                    &thread_id,
                    thread_started_at,
                    &thread,
                    &link,
                );
                if link.ephemeral {
                    continue;
                }
                if self.archived_link_is_deleted(&link) {
                    log_executor_event(
                        "runtime work codex link hidden by deleted marker",
                        &[
                            ("archived_query", archived.to_string()),
                            ("local_task_id", link.local_task_id.clone()),
                            (
                                "thread_id",
                                link.thread_id.as_deref().unwrap_or("none").to_owned(),
                            ),
                            ("workspace_path", link.workspace_path.clone()),
                        ],
                    );
                    continue;
                }
                if archived {
                    link.status = "archived".to_owned();
                    link.running = false;
                    link.continuable = false;
                } else if link.status == "archived" {
                    continue;
                }
                link.list_order = Some(links.len());
                if let Some(thread_id) = &link.thread_id {
                    discovered_thread_ids.insert(thread_id.clone());
                }
                discovered_local_task_ids.insert(link.local_task_id.clone());
                links.push(link);
            } else {
                log_slow_runtime_collect_thread_missing(
                    archived,
                    &thread_id,
                    thread_started_at,
                    &thread,
                );
            }
        }
        log_runtime_collect_diagnostic(
            "threads_linked",
            archived,
            started_at,
            stage_started_at,
            &[
                ("links", links.len().to_string()),
                ("threads", discovered_thread_ids.len().to_string()),
            ],
        );

        let stage_started_at = Instant::now();
        for mut link in self.local_task_links(true) {
            if self.archived_link_is_deleted(&link) {
                continue;
            }
            if link.ephemeral {
                continue;
            }
            let link_archived = link.status == "archived";
            if link_archived != archived {
                continue;
            }
            if is_cached_codex_link_hidden(&link, &discovered_thread_ids) {
                continue;
            }
            if discovered_local_task_ids.contains(&link.local_task_id) {
                continue;
            }
            if link
                .thread_id
                .as_ref()
                .is_some_and(|thread_id| discovered_thread_ids.contains(thread_id))
            {
                continue;
            }
            if !self.is_active_local_task(&link.local_task_id)
                && normalize_inactive_running_codex_task(&mut link)
            {
                self.store.upsert_task(link.clone());
            }
            link.list_order = Some(links.len());
            links.push(link);
        }
        log_runtime_collect_diagnostic(
            "local_links_merged",
            archived,
            started_at,
            stage_started_at,
            &[("links", links.len().to_string())],
        );

        links
    }

    pub(super) async fn codex_threads(&self, archived: bool) -> Vec<Value> {
        let started_at = Instant::now();
        let mut threads = Vec::new();
        let mut cursor = None;
        let mut pages = 0_usize;
        self.ensure_notification_router().await;
        loop {
            let params = codex_thread_list_params(archived, cursor.as_deref());
            let response = match self.codex_app_server.request("thread/list", params).await {
                Ok(response) => response,
                Err(error) => {
                    log_executor_event(
                        "runtime work thread list failed",
                        &[
                            ("elapsed_ms", elapsed_ms(started_at)),
                            ("archived", archived.to_string()),
                            ("threads", threads.len().to_string()),
                            ("pages", pages.to_string()),
                            ("error", error),
                        ],
                    );
                    break;
                }
            };
            let Some(data) = response.get("data").and_then(Value::as_array) else {
                log_executor_event(
                    "runtime work thread list malformed",
                    &[
                        ("elapsed_ms", elapsed_ms(started_at)),
                        ("archived", archived.to_string()),
                        ("threads", threads.len().to_string()),
                        ("pages", pages.to_string()),
                        ("error", "missing data array".to_owned()),
                    ],
                );
                break;
            };
            pages += 1;
            threads.extend(data.iter().cloned());
            cursor = string_field(&response, "nextCursor");
            if cursor.is_none() || threads.len() >= CODEX_THREAD_LIST_MAX_ITEMS {
                break;
            }
        }

        if threads.len() > CODEX_THREAD_LIST_MAX_ITEMS {
            threads.truncate(CODEX_THREAD_LIST_MAX_ITEMS);
        }
        log_executor_event(
            "runtime work thread list fetched",
            &[
                ("elapsed_ms", elapsed_ms(started_at)),
                ("archived", archived.to_string()),
                ("threads", threads.len().to_string()),
                ("pages", pages.to_string()),
                (
                    "truncated",
                    (threads.len() >= CODEX_THREAD_LIST_MAX_ITEMS).to_string(),
                ),
            ],
        );
        threads
    }

    pub(super) async fn thread_path_for_id(&self, thread_id: &str) -> Option<String> {
        for thread in self.codex_threads(false).await {
            if string_field(&thread, "id").as_deref() == Some(thread_id) {
                return string_field(&thread, "path").filter(|path| !path.trim().is_empty());
            }
        }
        None
    }

    pub(super) fn visible_links_for_projects(
        &self,
        links: Vec<RuntimeTaskLink>,
        project_index: &CodexGlobalProjectIndex,
    ) -> Vec<RuntimeTaskLink> {
        let links = links
            .into_iter()
            .map(|mut link| {
                if !is_codex_runtime(&link.runtime) {
                    return link;
                }

                if let Some(thread_id) = link.thread_id.as_deref() {
                    link.pinned = project_index.is_pinned_thread(thread_id);
                    link.pinned_order = project_index.pinned_thread_order(thread_id);
                    if infer_workspace_kind(&link.workspace_path) == "chat" {
                        link.list_order = Some(project_index.thread_sort_order(
                            "chats",
                            thread_id,
                            link.list_order.unwrap_or(usize::MAX / 2),
                        ));
                    }
                }
                link
            })
            .collect::<Vec<_>>();
        let input_count = links.len();
        let project_count = project_index.projects().len();
        let project_roots = project_index
            .projects()
            .iter()
            .map(|project| project.workspace_path.as_str())
            .collect::<Vec<_>>()
            .join("|");

        if !project_index.has_projects() && !project_index.has_project_state() {
            log_executor_event(
                "runtime work project filter skipped",
                &[
                    ("reason", "no_project_state".to_owned()),
                    ("input_links", input_count.to_string()),
                    ("project_count", project_count.to_string()),
                    (
                        "project_state_loaded",
                        project_index.has_project_state().to_string(),
                    ),
                ],
            );
            return links;
        }

        let mut visible_links = Vec::with_capacity(input_count);
        let mut kept_non_codex = 0_usize;
        let mut kept_chat = 0_usize;
        let mut kept_project = 0_usize;
        let mut filtered_projectless = 0_usize;
        let mut filtered_no_project = 0_usize;

        for mut link in links {
            if !is_codex_runtime(&link.runtime) {
                kept_non_codex += 1;
                log_runtime_project_filter_item(
                    &link,
                    RuntimeProjectFilterLog {
                        action: "keep",
                        reason: "non_codex_runtime",
                        workspace_kind: infer_workspace_kind(&link.workspace_path),
                        group_path: None,
                        matched_by: None,
                        project_workspace_path: None,
                        project_name: None,
                        thread_hint: None,
                        project_count,
                    },
                );
                visible_links.push(link);
                continue;
            }

            let workspace_kind = infer_workspace_kind(&link.workspace_path);
            if workspace_kind == "chat" {
                kept_chat += 1;
                log_runtime_project_filter_item(
                    &link,
                    RuntimeProjectFilterLog {
                        action: "keep",
                        reason: "chat_workspace",
                        workspace_kind,
                        group_path: None,
                        matched_by: None,
                        project_workspace_path: None,
                        project_name: None,
                        thread_hint: None,
                        project_count,
                    },
                );
                visible_links.push(link);
                continue;
            }

            let group_path = self
                .worktrees
                .source_path_for(&link.workspace_path)
                .unwrap_or_else(|| workspace_group_path(&link.workspace_path));
            let thread_id = link.thread_id.as_deref();
            let thread_hint = thread_id.and_then(|id| project_index.thread_workspace_hint(id));
            if thread_id.is_some_and(|id| project_index.is_projectless_thread(id)) {
                filtered_projectless += 1;
                log_runtime_project_filter_item(
                    &link,
                    RuntimeProjectFilterLog {
                        action: "filter",
                        reason: "projectless_thread",
                        workspace_kind,
                        group_path: Some(&group_path),
                        matched_by: None,
                        project_workspace_path: None,
                        project_name: None,
                        thread_hint,
                        project_count,
                    },
                );
                continue;
            }

            let explicit_project = link
                .runtime_project_key
                .as_deref()
                .and_then(|project_key| project_index.project_for_key(project_key));
            let direct_project = explicit_project
                .or_else(|| project_index.project_for_thread(thread_id, &link.workspace_path));
            let group_project = if direct_project.is_none() {
                project_index.project_for_thread(thread_id, &group_path)
            } else {
                None
            };
            let project = direct_project.or(group_project);

            let Some(project) = project else {
                filtered_no_project += 1;
                log_runtime_project_filter_item(
                    &link,
                    RuntimeProjectFilterLog {
                        action: "filter",
                        reason: "no_matching_project",
                        workspace_kind,
                        group_path: Some(&group_path),
                        matched_by: None,
                        project_workspace_path: None,
                        project_name: None,
                        thread_hint,
                        project_count,
                    },
                );
                continue;
            };

            let matched_by = if let Some(hinted_root) = thread_hint {
                if project_index
                    .project_for_key(hinted_root)
                    .is_some_and(|hinted_project| {
                        hinted_project.workspace_path == project.workspace_path
                    })
                {
                    "thread_hint"
                } else if direct_project.is_some() {
                    "workspace_path"
                } else {
                    "group_path"
                }
            } else if direct_project.is_some() {
                "workspace_path"
            } else {
                "group_path"
            };
            let project_workspace_path = project.workspace_path.clone();
            let project_key = project.key.clone();
            let project_name = project.name.clone();
            link.group_workspace_path = Some(project_workspace_path.clone());
            link.group_project_key = Some(project_key.clone());
            if let Some(thread_id) = link.thread_id.as_deref() {
                link.list_order = Some(project_index.thread_sort_order(
                    &project_key,
                    thread_id,
                    link.list_order.unwrap_or(usize::MAX / 2),
                ));
            }
            kept_project += 1;
            log_runtime_project_filter_item(
                &link,
                RuntimeProjectFilterLog {
                    action: "keep",
                    reason: "matched_project",
                    workspace_kind,
                    group_path: Some(&group_path),
                    matched_by: Some(matched_by),
                    project_workspace_path: Some(&project_workspace_path),
                    project_name: Some(&project_name),
                    thread_hint,
                    project_count,
                },
            );
            visible_links.push(link);
        }

        log_executor_event(
            "runtime work project filter finished",
            &[
                ("input_links", input_count.to_string()),
                ("visible_links", visible_links.len().to_string()),
                (
                    "filtered_links",
                    (filtered_projectless + filtered_no_project).to_string(),
                ),
                ("project_count", project_count.to_string()),
                (
                    "project_state_loaded",
                    project_index.has_project_state().to_string(),
                ),
                ("project_roots", project_roots),
                ("kept_non_codex", kept_non_codex.to_string()),
                ("kept_chat", kept_chat.to_string()),
                ("kept_project", kept_project.to_string()),
                ("filtered_projectless", filtered_projectless.to_string()),
                ("filtered_no_project", filtered_no_project.to_string()),
            ],
        );

        visible_links
    }

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
        match self
            .codex_app_server
            .request(
                "thread/read",
                json!({"threadId": thread_id, "includeTurns": true}),
            )
            .await
        {
            Ok(response) => {
                let thread = response.get("thread").unwrap_or(&response);
                transcript_messages(thread, &self.device_id)
            }
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
        let mut link =
            RuntimeTaskLink::from_thread_metadata(thread, local_link, workspace_path, local_active);
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

    pub(super) fn upsert_local_task(&self, link: RuntimeTaskLink) {
        self.store.upsert_task(link);
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
        self.store.update_task(local_task_id, |link| {
            if thread_id.is_some() {
                link.thread_id = thread_id;
            }
            link.status = status.to_owned();
            link.running = status == "running";
            link.thread_status = if link.running { "active" } else { "idle" }.to_owned();
            link.turn_status = match status {
                "running" => Some("inProgress".to_owned()),
                "done" => Some("completed".to_owned()),
                "cancelled" => Some("interrupted".to_owned()),
                "failed" => Some("failed".to_owned()),
                _ => link.turn_status.clone(),
            };
            link.updated_at = now_ms();
            if status != "running" {
                link.completed_at = Some(link.updated_at);
            }
            if link.thread_id.is_some() && status != "running" {
                retain_runtime_handle_user_messages(&mut link.runtime_handle);
            }
        });
        if status != "running" {
            self.unmark_active_local_task(local_task_id);
        }
    }

    pub(super) fn sync_runtime_task_goal_from_notification(
        &self,
        local_task_id: &str,
        message: &Value,
    ) {
        let notification = codex_notification(message);
        let goal_status = match notification.method.as_str() {
            "thread/goal/updated" => notification
                .params
                .get("goal")
                .and_then(|goal| string_field(goal, "status")),
            "thread/goal/cleared" => None,
            _ => return,
        };
        self.sync_runtime_task_goal_status(local_task_id, goal_status);
    }

    pub(super) fn sync_runtime_task_goal_status(
        &self,
        local_task_id: &str,
        goal_status: Option<String>,
    ) {
        self.store.update_task(local_task_id, |link| {
            link.goal_status = goal_status.clone();
            link.updated_at = now_ms();
        });
    }
}
