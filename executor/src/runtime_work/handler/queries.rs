// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
    /// Read task identity and model configuration without starting a provider or returning profiles.
    pub(super) fn get_task(&self, payload: &Value) -> Result<Value, AppIpcError> {
        let task_id = runtime_task_id(payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let link = self
            .store
            .get_task_summary(&task_id)
            .filter(|link| !self.archived_link_is_deleted(link));
        let Some(mut link) = link else {
            return Ok(json!({
                "success": false,
                "code": "task_not_found",
                "error": "Task not found on the owning Runtime",
            }));
        };
        log_runtime_archive_link("runtime task get resolved link", &link, false);
        if link.status == "archived" {
            return Ok(json!({
                "success": false,
                "code": "task_archived",
                "error": "This task has been archived. Restore it from archived tasks before opening it.",
            }));
        }
        apply_local_execution_state(
            &mut link,
            self.is_active_local_task(&task_id),
            self.queued_local_task_position(&task_id),
        );
        link.git_info = crate::runtime_work::response::git_info_for_workspace(
            link.git_info.take(),
            &link.workspace_path,
        );
        // Return only the identity/configuration needed by a client to continue.
        // Execution profiles and transcript caches remain on the owning Runtime.
        let thread_id = link.thread_id.clone();
        let active_provider = super::conversation_provider::active_provider(&link);
        let last_turn_id = crate::runtime_work::lifecycle::native_execution_state(&link)
            .and_then(|state| state.latest_turn_id);
        let mut task = crate::runtime_work::response::local_task_json(link);
        if let Some(handle) = task["runtimeHandle"].as_object_mut() {
            handle.retain(|key, _| {
                matches!(
                    key.as_str(),
                    "runtime"
                        | "wegentTeam"
                        | "modelSelection"
                        | "model_selection"
                        | "origin"
                        | "changeRequests"
                        | "queuePosition"
                        | "modelProviderRouting"
                        | "quotaWait"
                )
            });
            // The serializer originally adds this authoritative identity after
            // filtering the stored handle; preserve that response contract.
            handle.insert("threadId".to_owned(), json!(thread_id));
            if let Some(provider) = active_provider {
                handle.insert("activeModelProvider".to_owned(), provider);
            }
            // Preserve the current-epoch lifecycle projection, not a stored handle value.
            if let Some(turn_id) = last_turn_id {
                handle.insert("lastTurnId".to_owned(), json!(turn_id));
            }
        }
        Ok(json!({
            "success": true,
            "task": task,
        }))
    }

    pub(super) async fn read_codex_turn_page(
        &self,
        thread_id: &str,
        limit: usize,
        direction: CodexTranscriptDirection,
    ) -> Result<Value, String> {
        let page = load_codex_transcript(
            &self.codex_app_server,
            CodexTranscriptRequest {
                thread_id,
                cursor: None,
                limit,
                direction,
                full_content: false,
                bounded_items: false,
                prefer_rollout_history: false,
            },
        );
        #[cfg(test)]
        let page = match self.transcript_test_workers.clone() {
            Some(workers) => {
                crate::runtime_work::transcript_work::with_test_workers(workers, page).await
            }
            None => page.await,
        };
        #[cfg(not(test))]
        let page = page.await;
        page.map(|page| page.thread)
            .map_err(|error| error.to_string())
    }

    pub(super) async fn list_tasks(&self, payload: &Value) -> Result<Value, AppIpcError> {
        let started_at = Instant::now();
        log_runtime_work_list_diagnostic("started", started_at, started_at, &[]);
        let stage_started_at = Instant::now();
        let project_index = CodexGlobalProjectIndex::load();
        log_runtime_work_list_diagnostic(
            "project_index_loaded",
            started_at,
            stage_started_at,
            &[
                ("projects", project_index.projects().len().to_string()),
                (
                    "project_state_loaded",
                    project_index.has_project_state().to_string(),
                ),
            ],
        );
        self.list_tasks_with_project_index(payload, &project_index, started_at)
            .await
    }

    pub(super) async fn list_tasks_with_project_index(
        &self,
        payload: &Value,
        project_index: &CodexGlobalProjectIndex,
        started_at: Instant,
    ) -> Result<Value, AppIpcError> {
        let prefer_cached = bool_field(payload, "preferCached").unwrap_or(false);
        let pending_only = bool_field(payload, "pendingOnly").unwrap_or(false);
        let stage_started_at = Instant::now();
        let (collected_links, catalog_complete) = if prefer_cached {
            (self.collect_cached_links(false), false)
        } else {
            self.collect_query_links(false).await
        };
        log_runtime_work_list_diagnostic(
            "links_collected",
            started_at,
            stage_started_at,
            &[("links", collected_links.len().to_string())],
        );
        let stage_started_at = Instant::now();
        let links = if pending_only {
            collected_links
                .into_iter()
                .filter(|link| {
                    matches!(
                        link.interaction_status.as_deref(),
                        Some("waitingForUserInput" | "awaitingUserReply")
                    )
                })
                .collect()
        } else {
            self.visible_links_for_projects(collected_links, project_index)
        };
        log_runtime_work_list_diagnostic(
            "project_filter_applied",
            started_at,
            stage_started_at,
            &[("visible_links", links.len().to_string())],
        );
        let stage_started_at = Instant::now();
        let workspaces = workspace_response(links, codex_project_workspaces(project_index));
        let task_count = workspaces
            .iter()
            .filter_map(|workspace| workspace.get("tasks").and_then(Value::as_array))
            .map(Vec::len)
            .sum::<usize>();
        log_runtime_work_list_diagnostic(
            "response_built",
            started_at,
            stage_started_at,
            &[
                ("workspaces", workspaces.len().to_string()),
                ("tasks", task_count.to_string()),
            ],
        );
        log_executor_event(
            "runtime work list finished",
            &[
                ("elapsed_ms", elapsed_ms(started_at)),
                ("workspaces", workspaces.len().to_string()),
                ("tasks", task_count.to_string()),
            ],
        );
        // Pending decisions are framework-owned state, not a provider discovery request.
        if prefer_cached && !pending_only {
            self.reconcile_codex_threads_after_cached_list();
        }
        let mut response = json!({
            "success": true,
            "workspaces": workspaces,
            "coverage": {"authorized_index_complete":catalog_complete,"unavailable_reasons":if catalog_complete {json!({})} else {json!({"native_catalog_unavailable":1})}},
        });
        if pending_only {
            let users = crate::local::app_ipc::human_request_viewer_ids(
                payload,
                "localIssueUserIds",
                &[0],
            )?;
            match LocalTaskStore::pending_issue_human_requests_at(
                self.task_store_path.as_ref(),
                &users,
            ) {
                Ok(pending) => response["localIssueQuestionsPending"] = json!(pending),
                Err(error) => log_executor_event(
                    "pending Issue question hint failed",
                    &[("error", error.to_string())],
                ),
            }
        }
        Ok(response)
    }

    fn reconcile_codex_threads_after_cached_list(&self) {
        let handler = self.clone();
        tokio::spawn(async move {
            let started_at = Instant::now();
            handler.collect_links(false).await;
            log_executor_event(
                "runtime work cached list reconciliation finished",
                &[("elapsed_ms", elapsed_ms(started_at))],
            );
            emit_runtime_work_changed(
                &handler.event_tx,
                &handler.device_id,
                "runtime-work-bootstrap",
            );
        });
    }

    pub(super) async fn list_archived_conversations(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        if string_field(&payload, "source")
            .is_some_and(|source| source.eq_ignore_ascii_case("cloud"))
        {
            return Ok(archived_conversations_response(Vec::new(), &self.device_id));
        }

        let (mut links, catalog_complete) = self.collect_query_links(true).await;
        if let Some(workspace_path) = string_field(&payload, "workspacePath")
            .or_else(|| string_field(&payload, "workspace_path"))
        {
            links.retain(|link| link.workspace_path == workspace_path);
        }
        if let Some(search) = string_field(&payload, "search") {
            links.retain(|link| {
                text_match(&link.title, &search).is_some()
                    || text_match(&link.workspace_path, &search).is_some()
            });
        }
        match string_field(&payload, "sort").as_deref() {
            Some("created") => links.sort_by_key(|link| std::cmp::Reverse(link.created_at)),
            Some("alphabetical") => links.sort_by(|left, right| left.title.cmp(&right.title)),
            _ => links.sort_by_key(|link| std::cmp::Reverse(link.updated_at)),
        }

        let mut result = archived_conversations_response(links, &self.device_id);
        result["coverage"] = json!({"authorized_index_complete":catalog_complete,"unavailable_reasons":if catalog_complete {json!({})} else {json!({"native_catalog_unavailable":1})}});
        Ok(result)
    }

    pub(super) async fn search_tasks(&self, payload: Value) -> Result<Value, AppIpcError> {
        let query = string_field(&payload, "query").unwrap_or_default();
        if query.is_empty() {
            return Ok(json!({"success": true, "items": []}));
        }
        let limit = integer_field(&payload, "limit")
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| *value > 0)
            .unwrap_or(20)
            .min(100);

        let mut links = self.collect_links(false).await;
        if bool_field(&payload, "includeArchived").unwrap_or(false) {
            let archived_links = self.collect_links(true).await;
            append_unique_links(&mut links, archived_links);
        }

        let mut items = Vec::new();
        let mut matched_local_task_ids = HashSet::new();
        for link in &links {
            if let Some((match_start, match_end)) = text_match(&link.title, &query) {
                items.push(search_result_item(
                    link,
                    &self.device_id,
                    SearchResultMatch {
                        snippet: link.title.clone(),
                        match_start,
                        match_end,
                        message_id: String::new(),
                        message_role: "title".to_owned(),
                        message_created_at: json!(link.updated_at),
                    },
                ));
                matched_local_task_ids.insert(link.local_task_id.clone());
                if items.len() >= limit {
                    return Ok(json!({"success": true, "items": items}));
                }
            }
        }

        for link in &links {
            if matched_local_task_ids.contains(&link.local_task_id) {
                continue;
            }
            let messages = if runtime_has_provider_transcript_reader(&link.runtime) {
                let thread_ids = match crate::runtime_work::conversation_sessions::thread_ids(link)
                {
                    Ok(ids) => ids,
                    Err(error) => {
                        log_executor_event(
                            "task search skipped invalid conversation sessions",
                            &[
                                ("local_task_id", link.local_task_id.clone()),
                                ("error", error.to_string()),
                            ],
                        );
                        continue;
                    }
                };
                let mut matched = None;
                for thread_id in thread_ids.iter().rev() {
                    matched = first_message_search_result(
                        link,
                        &self.device_id,
                        self.thread_messages(thread_id).await,
                        &query,
                    );
                    if matched.is_some() {
                        break;
                    }
                }
                if let Some(item) = matched {
                    items.push(item);
                    if items.len() >= limit {
                        break;
                    }
                }
                continue;
            } else {
                cached_runtime_transcript_messages(link)
            };
            if let Some(item) = first_message_search_result(link, &self.device_id, messages, &query)
            {
                items.push(item);
                if items.len() >= limit {
                    break;
                }
            }
        }

        Ok(json!({"success": true, "items": items}))
    }

    pub(super) async fn transcript(&self, payload: Value) -> Result<Value, AppIpcError> {
        #[cfg(test)]
        if let Some(workers) = self.transcript_test_workers.clone() {
            return super::super::transcript_work::with_test_workers(
                workers,
                self.transcript_response(payload),
            )
            .await;
        }
        self.transcript_response(payload).await
    }

    async fn transcript_response(&self, mut payload: Value) -> Result<Value, AppIpcError> {
        use crate::runtime_work::transcript_transport;
        let task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let versioned = transcript_transport::requested(&payload)?;
        if payload["identityOnly"] == true {
            return self.transcript_identity(&task_id);
        }
        let runtime_directory = self
            .store
            .index_path()
            .parent()
            .ok_or_else(|| {
                AppIpcError::new(
                    "transcript_transport_failed",
                    "Missing Runtime storage directory",
                )
            })?
            .to_owned();
        let requested_session_id = runtime_session_id_from_payload(&payload);
        let snapshot_directory = || {
            let session_id = requested_session_id.clone().or_else(|| {
                self.store
                    .read_task(&task_id, runtime_session_id_from_link)
                    .flatten()
            });
            transcript_transport::snapshot_directory(
                &runtime_directory,
                &json!({"taskId": task_id, "threadId": session_id}),
            )
        };
        if let Some(transfer) = payload.get("transcriptTransfer").cloned() {
            if !versioned {
                return Err(AppIpcError::new(
                    "bad_request",
                    "Transcript transfer requires protocol 2",
                ));
            }
            let directory = snapshot_directory();
            return super::super::transcript_work::run(move |cancellation| {
                cancellation.check()?;
                transcript_transport::read_chunk(&directory, &transfer)
            })
            .await;
        }
        if versioned && transcript_limit(&payload).is_none() {
            let limit = 5;
            payload["limit"] = json!(limit);
        }
        let reconciliation_ids = super::transcript_read_link::reconciliation_ids(&payload)?;
        let mut response = self.read_transcript(payload).await?;
        if let Some(requested) = reconciliation_ids {
            if let Some(accepted) =
                self.accepted_reconciliation_ids(&task_id, &response, &requested)
            {
                response["acceptedClientUserMessageIds"] = json!(accepted);
            }
        }
        if let Some(origin) = self
            .store
            .read_task(&task_id, |link| link.runtime_handle.get("origin").cloned())
            .flatten()
        {
            response["origin"] = origin;
        }
        if !versioned {
            return Ok(response);
        }
        // A refresh can replace the linked provider session before publishing.
        let directory = snapshot_directory();
        super::super::transcript_work::run(move |cancellation| {
            cancellation.check()?;
            transcript_transport::remove_expired_transfers(&runtime_directory)?;
            transcript_transport::encode_cancellable(&directory, response, cancellation)
        })
        .await
    }

    /// Record the resolved task's model identity before reading cached or native transcript content.
    pub(super) async fn read_thread_transcript(
        &self,
        payload: Value,
        historical_link: Option<RuntimeTaskLink>,
    ) -> Result<Value, AppIpcError> {
        let started_at = Instant::now();
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        delay_desktop_e2e_transcript_response().await;
        let limit = transcript_limit(&payload);
        let before_cursor = string_field(&payload, "beforeCursor")
            .or_else(|| string_field(&payload, "before_cursor"));
        let after_cursor = string_field(&payload, "afterCursor")
            .or_else(|| string_field(&payload, "after_cursor"));
        let search_match_requested = before_cursor
            .as_deref()
            .or(after_cursor.as_deref())
            .is_some_and(crate::runtime_work::codex_transcript_search::is_search_cursor);
        if before_cursor.is_some() && after_cursor.is_some() {
            return Err(AppIpcError::new(
                "bad_request",
                "Codex transcript pagination accepts only one cursor at a time",
            ));
        }
        let include_full_content = bool_field(&payload, "includeFullContent")
            .or_else(|| bool_field(&payload, "include_full_content"))
            .unwrap_or(false);
        let conversation_context_only = bool_field(&payload, "conversationContextOnly")
            .or_else(|| bool_field(&payload, "conversation_context_only"))
            .unwrap_or(false);
        let full_item_content = search_match_requested
            || include_full_content
            || conversation_context_only
            || payload
                .get("transcriptProtocolVersion")
                .and_then(Value::as_u64)
                == Some(2);
        let navigation_only = bool_field(&payload, "navigationOnly")
            .or_else(|| bool_field(&payload, "navigation_only"))
            .unwrap_or(false);
        if navigation_only && include_full_content {
            return Err(AppIpcError::new(
                "bad_request",
                "navigationOnly cannot be combined with includeFullContent",
            ));
        }
        let refresh = bool_field(&payload, "refresh")
            .or_else(|| bool_field(&payload, "forceRefresh"))
            .unwrap_or(false);
        let bounded_native = payload["transcriptProtocolVersion"] == 2
            && !include_full_content
            && !navigation_only
            && !search_match_requested
            && !conversation_context_only
            && !before_cursor
                .as_deref()
                .or(after_cursor.as_deref())
                .is_some_and(super::transcript_search::is_cached_search_cursor);
        let historical_session = historical_link.is_some();
        let (local_link, bounded_native_page) = if let Some(link) = historical_link {
            (Some(link), false)
        } else {
            self.transcript_read_link(&local_task_id, bounded_native)
        };
        if let Some(link) = local_link.as_ref() {
            log_runtime_archive_link("runtime task transcript resolved link", link, false);
        }
        let codex_client = match local_link.as_ref() {
            Some(link) => self
                .codex_app_server
                .for_request(&runtime_event_request_from_link(link)),
            None => Ok(self.codex_app_server.clone()),
        }
        .map_err(|error| AppIpcError::new("codex_error", error))?;
        let linked_session_id = local_link.as_ref().and_then(runtime_session_id_from_link);
        let requested_session_id = runtime_session_id_from_payload(&payload);
        let direct_thread_override = historical_session
            || requested_session_id
                .as_deref()
                .zip(linked_session_id.as_deref())
                .is_some_and(|(requested, linked)| requested != linked);
        let session_id = requested_session_id.or(linked_session_id);
        let running_hint = local_link.as_ref().is_some_and(|link| link.running);
        let local_execution_running = self.is_active_local_task(&local_task_id);
        if let (Some(link), Some(cursor)) = (
            local_link.as_ref(),
            before_cursor.as_deref().or(after_cursor.as_deref()),
        ) {
            if let Some(response) = super::transcript_search::cached_search_match_response(
                link,
                cursor,
                limit,
                local_execution_running,
                after_cursor.is_some(),
            )? {
                return Ok(response);
            }
        }
        if navigation_only {
            if let Some(link) = local_link.as_ref().filter(|link| link.ephemeral) {
                let mut messages = cached_temporary_transcript_messages(link);
                append_unique_transcript_messages(
                    &mut messages,
                    self.active_codex_transcript_messages(&local_task_id),
                );
                let page_messages = messages.clone();
                attach_user_message_presentations_for_page(
                    &mut messages,
                    user_message_presentations(link),
                    &page_messages,
                    &[],
                    false,
                    false,
                );
                return Ok(transcript_navigation_response(
                    local_task_id,
                    link.workspace_path.clone(),
                    transcript_turn_navigation(&messages),
                ));
            }
            if !direct_thread_override
                && local_link
                    .as_ref()
                    .is_some_and(provider_transcript_is_unmaterialized)
            {
                return Ok(transcript_navigation_response(
                    local_task_id,
                    local_link
                        .as_ref()
                        .map(|link| link.workspace_path.clone())
                        .unwrap_or_default(),
                    Vec::new(),
                ));
            }
            let Some(thread_id) = session_id else {
                return Ok(transcript_navigation_response(
                    local_task_id,
                    workspace_path(&payload).unwrap_or_default(),
                    Vec::new(),
                ));
            };
            if !refresh {
                if let Some(navigation) = self.cached_codex_transcript_navigation(&thread_id) {
                    let workspace_path = local_link
                        .as_ref()
                        .map(|link| link.workspace_path.clone())
                        .filter(|path| !path.trim().is_empty())
                        .or_else(|| workspace_path(&payload))
                        .unwrap_or_default();
                    return Ok(transcript_navigation_response(
                        local_task_id,
                        workspace_path,
                        transcript_navigation_from_codex_turns(navigation),
                    ));
                }
            }
            let metadata_response = read_codex_thread_metadata(&codex_client, &thread_id)
                .await
                .map_err(|error| AppIpcError::new("codex_error", error))?;
            let thread = metadata_response
                .get("thread")
                .cloned()
                .filter(Value::is_object)
                .ok_or_else(|| {
                    AppIpcError::new(
                        "codex_error",
                        "thread/read returned a response without thread",
                    )
                })?;
            let workspace_path = local_link
                .as_ref()
                .map(|link| link.workspace_path.clone())
                .filter(|path| !path.trim().is_empty())
                .or_else(|| string_field(&thread, "cwd"))
                .or_else(|| workspace_path(&payload))
                .unwrap_or_default();
            let prefer_rollout_history = local_link.as_ref().is_some_and(uses_rollout_history);
            let navigation = self
                .codex_transcript_navigation(
                    &codex_client,
                    &thread,
                    &thread_id,
                    prefer_rollout_history,
                    refresh,
                )
                .await?;
            return Ok(transcript_navigation_response(
                local_task_id,
                workspace_path,
                transcript_navigation_from_codex_turns(navigation),
            ));
        }
        if local_execution_running
            && !refresh
            && !direct_thread_override
            && before_cursor.is_none()
            && after_cursor.is_none()
        {
            if let Some(link) = local_link.as_ref().filter(|link| {
                runtime_has_provider_transcript_reader(&link.runtime) && link.runtime != "codex"
            }) {
                let mut messages = transcript_snapshot_messages(link);
                append_unique_transcript_messages(
                    &mut messages,
                    cached_runtime_transcript_messages(link),
                );
                append_unique_transcript_messages(
                    &mut messages,
                    completed_transcript_messages(link),
                );
                append_unique_transcript_messages(
                    &mut messages,
                    self.active_codex_transcript_messages(&local_task_id),
                );
                if !messages.is_empty() {
                    let presentation_page_messages = messages.clone();
                    attach_user_message_presentations_for_page(
                        &mut messages,
                        user_message_presentations(link),
                        &presentation_page_messages,
                        &[],
                        false,
                        false,
                    );
                    if conversation_context_only {
                        project_conversation_context_messages(&mut messages);
                    }
                    log_runtime_transcript_finished(RuntimeTranscriptLog {
                        started_at,
                        local_task_id: &local_task_id,
                        thread_id: session_id.as_deref().unwrap_or(""),
                        source: "active_runtime_cache",
                        refresh,
                        running_hint,
                        limit,
                        before_cursor: before_cursor.as_deref(),
                        after_cursor: after_cursor.as_deref(),
                        message_count: messages.len(),
                        running: true,
                    });
                    return Ok(cached_transcript_response(
                        link,
                        messages,
                        None,
                        true,
                        limit,
                        before_cursor.as_deref(),
                        after_cursor.as_deref(),
                    ));
                }
            }
        }
        if let Some(link) = local_link.as_ref().filter(|link| {
            link.ephemeral
                || !runtime_has_provider_transcript_reader(&link.runtime)
                || session_id.is_none()
                || (!bounded_native_page
                    && !direct_thread_override
                    && provider_transcript_is_unmaterialized(link))
        }) {
            let mut messages = if link.ephemeral {
                let mut messages = cached_temporary_transcript_messages(link);
                append_unique_transcript_messages(
                    &mut messages,
                    self.active_codex_transcript_messages(&local_task_id),
                );
                messages
            } else {
                cached_runtime_transcript_messages(link)
            };
            let page_messages = messages.clone();
            attach_user_message_presentations_for_page(
                &mut messages,
                user_message_presentations(link),
                &page_messages,
                &[],
                false,
                false,
            );
            if conversation_context_only {
                project_conversation_context_messages(&mut messages);
            }
            log_runtime_transcript_finished(RuntimeTranscriptLog {
                started_at,
                local_task_id: &local_task_id,
                thread_id: session_id.as_deref().unwrap_or(""),
                source: "runtime_handle",
                refresh,
                running_hint,
                limit,
                before_cursor: before_cursor.as_deref(),
                after_cursor: after_cursor.as_deref(),
                message_count: messages.len(),
                running: link.running,
            });
            return Ok(cached_transcript_response(
                link,
                messages,
                None,
                local_execution_running,
                limit,
                before_cursor.as_deref(),
                after_cursor.as_deref(),
            ));
        }

        let Some(mut thread_id) = session_id else {
            let workspace_path = workspace_path(&payload).unwrap_or_default();
            let runtime = string_field(&payload, "runtime").unwrap_or_else(|| "runtime".to_owned());
            log_runtime_transcript_finished(RuntimeTranscriptLog {
                started_at,
                local_task_id: &local_task_id,
                thread_id: "",
                source: "pending_local_task",
                refresh,
                running_hint,
                limit,
                before_cursor: before_cursor.as_deref(),
                after_cursor: after_cursor.as_deref(),
                message_count: 0,
                running: local_execution_running,
            });
            let pagination = transcript_pagination(&runtime, limit, before_cursor, after_cursor);
            let mut response = transcript_response(TranscriptResponseInput {
                canonical_turns: None,
                local_task_id,
                workspace_path,
                runtime,
                messages: Vec::new(),
                context_usage: None,
                running: local_execution_running,
                pagination,
                full_content: include_full_content,
                conversation_context_only,
                turn_item_source: TranscriptTurnItemSource::CachedMessages,
                turn_navigation: Vec::new(),
            });
            // Creation may not have registered the task yet. Absence of a local
            // execution is unknown state, not evidence that the send has settled.
            if !local_execution_running
                && !local_link
                    .as_ref()
                    .is_some_and(|link| link.completed_at.is_some())
            {
                response.as_object_mut().unwrap().remove("running");
            }
            return Ok(response);
        };

        // Archived sessions are readable without resuming them. Named Homes
        // also stay read-only here: a resume would retain their writer lock.
        if refresh
            && !local_execution_running
            && !direct_thread_override
            && !codex_client.has_dedicated_home()
        {
            if let Some(link) = local_link
                .as_ref()
                .filter(|link| !link.ephemeral && link.status != "archived")
            {
                thread_id = self
                    .resume_codex_thread_for_action(link, &thread_id)
                    .await
                    .map_err(|error| AppIpcError::new("codex_error", error))?;
                log_executor_event(
                    "runtime work transcript resumed before refresh",
                    &[
                        ("local_task_id", local_task_id.clone()),
                        ("thread_id", thread_id.clone()),
                    ],
                );
            }
        }

        let transcript_page = load_codex_transcript(
            &codex_client,
            CodexTranscriptRequest {
                thread_id: &thread_id,
                cursor: before_cursor.as_deref().or(after_cursor.as_deref()),
                limit: limit
                    .filter(|value| *value > 0)
                    .unwrap_or(CODEX_TRANSCRIPT_PAGE_SIZE)
                    .min(CODEX_TRANSCRIPT_PAGE_SIZE),
                direction: if after_cursor.is_some() || payload["sessionReadAscending"] == true {
                    CodexTranscriptDirection::Ascending
                } else {
                    CodexTranscriptDirection::Descending
                },
                full_content: include_full_content,
                bounded_items: payload["transcriptProtocolVersion"] == 2,
                prefer_rollout_history: local_link.as_ref().is_some_and(uses_rollout_history),
            },
        )
        .await;
        let CodexTranscriptPage {
            thread,
            before_cursor: page_before_cursor,
            after_cursor: page_after_cursor,
        } = match transcript_page {
            Ok(page) => page,
            Err(error)
                if before_cursor.is_none()
                    && after_cursor.is_none()
                    && !direct_thread_override
                    && !matches!(
                        error.0.code.as_str(),
                        "runtime_read_busy" | "request_cancelled"
                    )
                    && local_link.as_ref().is_some_and(|link| {
                        link.runtime != "codex"
                            && (!transcript_snapshot_messages(link).is_empty()
                                || !completed_transcript_messages(link).is_empty())
                    }) =>
            {
                let link = local_link
                    .as_ref()
                    .expect("cached transcript fallback requires a local task");
                let mut messages = transcript_snapshot_messages(link);
                append_unique_transcript_messages(
                    &mut messages,
                    cached_runtime_transcript_messages(link),
                );
                append_unique_transcript_messages(
                    &mut messages,
                    completed_transcript_messages(link),
                );
                attach_user_message_presentations_for_page(
                    &mut messages,
                    user_message_presentations(link),
                    &[],
                    &[],
                    false,
                    false,
                );
                if conversation_context_only {
                    project_conversation_context_messages(&mut messages);
                }
                log_executor_event(
                    "runtime work provider transcript unavailable; using persisted snapshot",
                    &[
                        ("local_task_id", local_task_id.clone()),
                        ("thread_id", thread_id.clone()),
                        ("error", error.to_string()),
                    ],
                );
                log_runtime_transcript_finished(RuntimeTranscriptLog {
                    started_at,
                    local_task_id: &local_task_id,
                    thread_id: &thread_id,
                    source: "persisted_snapshot",
                    refresh,
                    running_hint,
                    limit,
                    before_cursor: None,
                    after_cursor: None,
                    message_count: messages.len(),
                    running: local_execution_running,
                });
                return Ok(cached_transcript_response(
                    link,
                    messages,
                    None,
                    local_execution_running,
                    limit,
                    None,
                    None,
                ));
            }
            Err(error) => {
                log_executor_event(
                    "runtime work native transcript read failed",
                    &[
                        ("local_task_id", local_task_id.clone()),
                        ("thread_id", thread_id.clone()),
                        ("code", error.0.code.clone()),
                        ("error", error.0.message.clone()),
                        (
                            "archived",
                            local_link
                                .as_ref()
                                .is_some_and(|link| link.status == "archived")
                                .to_string(),
                        ),
                    ],
                );
                return Err(error.0);
            }
        };
        let handler = self.clone();
        let input = super::queries_projection::TranscriptProjectionInput {
            payload,
            thread,
            local_task_id,
            thread_id,
            local_link,
            direct_thread_override,
            search_match_requested,
            full_item_content,
            limit,
            before_cursor,
            after_cursor,
            page_before_cursor,
            page_after_cursor,
            refresh,
            running_hint,
            started_at,
            include_full_content,
            conversation_context_only,
            bounded_native_page,
            historical_session,
        };
        super::super::transcript_work::run(move |cancellation| {
            handler.project_transcript_response(input, cancellation)
        })
        .await
    }

    async fn codex_transcript_navigation(
        &self,
        client: &CodexAppServerClient,
        thread: &Value,
        thread_id: &str,
        prefer_rollout_history: bool,
        refresh: bool,
    ) -> Result<CodexTranscriptNavigation, AppIpcError> {
        if !refresh {
            if let Some(navigation) = self.cached_codex_transcript_navigation(thread_id) {
                return Ok(navigation);
            }
        }

        let navigation =
            load_codex_transcript_navigation(client, thread, thread_id, prefer_rollout_history)
                .await
                .map_err(|error| AppIpcError::new("codex_error", error))?;
        let mut cache = self
            .codex_transcript_navigation_cache
            .lock()
            .expect("Codex transcript navigation cache lock should not be poisoned");
        cache.retain(|_, entry| entry.cached_at.elapsed() < CODEX_TRANSCRIPT_NAVIGATION_CACHE_TTL);
        if cache.len() >= CODEX_TRANSCRIPT_NAVIGATION_CACHE_MAX_ENTRIES {
            if let Some(oldest_key) = cache
                .iter()
                .max_by_key(|(_, entry)| entry.cached_at.elapsed())
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest_key);
            }
        }
        cache.insert(
            thread_id.to_owned(),
            CachedCodexTranscriptNavigation {
                cached_at: Instant::now(),
                navigation: navigation.clone(),
            },
        );
        Ok(navigation)
    }

    fn cached_codex_transcript_navigation(
        &self,
        thread_id: &str,
    ) -> Option<CodexTranscriptNavigation> {
        self.codex_transcript_navigation_cache
            .lock()
            .expect("Codex transcript navigation cache lock should not be poisoned")
            .get(thread_id)
            .filter(|entry| entry.cached_at.elapsed() < CODEX_TRANSCRIPT_NAVIGATION_CACHE_TTL)
            .map(|entry| entry.navigation.clone())
    }
}

fn uses_rollout_history(link: &RuntimeTaskLink) -> bool {
    // Native timeline paging rejects archived threads. Read their canonical
    // history directly, without unarchiving or resuming an execution.
    link.status == "archived"
        || link
            .runtime_handle
            .get("cloudTranscript")
            .is_some_and(Value::is_object)
}

async fn delay_desktop_e2e_transcript_response() {
    let Some(delay_ms) = std::env::var("WEWORK_E2E_RUNTIME_TRANSCRIPT_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
    else {
        return;
    };
    tokio::time::sleep(std::time::Duration::from_millis(delay_ms.min(10_000))).await;
}
