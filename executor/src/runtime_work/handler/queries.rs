// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn get_task(&self, payload: &Value) -> Result<Value, AppIpcError> {
        let task_id = runtime_task_id(payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let link = self
            .store
            .get_task_summary(&task_id)
            .filter(|link| link.status != "archived" && !self.archived_link_is_deleted(link));
        let Some(mut link) = link else {
            return Ok(json!({
                "success": false,
                "code": "task_not_found",
                "error": "Task not found on the owning Runtime",
            }));
        };
        apply_local_execution_state(
            &mut link,
            self.is_active_local_task(&task_id),
            self.queued_local_task_position(&task_id),
        );
        // Return only the identity/configuration needed by a client to continue.
        // Execution profiles and transcript caches remain on the owning Runtime.
        if let Some(handle) = link.runtime_handle.as_object_mut() {
            handle.retain(|key, _| {
                matches!(
                    key.as_str(),
                    "runtime"
                        | "wegentTeam"
                        | "modelSelection"
                        | "model_selection"
                        | "queuePosition"
                )
            });
        }
        Ok(json!({
            "success": true,
            "task": crate::runtime_work::response::local_task_json(link),
        }))
    }

    pub(super) async fn read_codex_recent_turns(&self, thread_id: &str) -> Result<Value, String> {
        load_codex_transcript(
            &self.codex_app_server,
            CodexTranscriptRequest {
                thread_id,
                cursor: None,
                limit: 1,
                direction: CodexTranscriptDirection::Descending,
                full_content: false,
                prefer_rollout_history: false,
            },
        )
        .await
        .map(|page| page.thread)
    }

    pub(super) async fn read_codex_turn_page(
        &self,
        thread_id: &str,
        limit: usize,
        direction: CodexTranscriptDirection,
    ) -> Result<Value, String> {
        load_codex_transcript(
            &self.codex_app_server,
            CodexTranscriptRequest {
                thread_id,
                cursor: None,
                limit,
                direction,
                full_content: false,
                prefer_rollout_history: false,
            },
        )
        .await
        .map(|page| page.thread)
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
        let stage_started_at = Instant::now();
        let collected_links = if prefer_cached {
            self.collect_cached_links(false)
        } else {
            self.collect_links(false).await
        };
        for link in &collected_links {
            self.project_runtime_link_status(link);
        }
        log_runtime_work_list_diagnostic(
            "links_collected",
            started_at,
            stage_started_at,
            &[("links", collected_links.len().to_string())],
        );
        let stage_started_at = Instant::now();
        let links = self.visible_links_for_projects(collected_links, project_index);
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
        if prefer_cached {
            self.reconcile_codex_threads_after_cached_list();
        }
        Ok(json!({
            "success": true,
            "workspaces": workspaces,
        }))
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

        let mut links = self.collect_links(true).await;
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

        Ok(archived_conversations_response(links, &self.device_id))
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
                let Some(thread_id) = link.thread_id.as_deref() else {
                    continue;
                };
                self.thread_messages(thread_id).await
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
        let task_id = runtime_task_id(&payload);
        let mut response = self.read_transcript(payload).await?;
        if let Some(link) = task_id.as_deref().and_then(|id| self.local_task_link(id)) {
            if let Some(origin) = link.runtime_handle.get("origin") {
                response["origin"] = origin.clone();
            }
        }
        Ok(response)
    }

    async fn read_transcript(&self, payload: Value) -> Result<Value, AppIpcError> {
        let started_at = Instant::now();
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        delay_desktop_e2e_transcript_response().await;
        let limit = transcript_limit(&payload);
        let before_cursor = string_field(&payload, "beforeCursor")
            .or_else(|| string_field(&payload, "before_cursor"));
        let after_cursor = string_field(&payload, "afterCursor")
            .or_else(|| string_field(&payload, "after_cursor"));
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
        let local_link = self.local_task_link(&local_task_id);
        let linked_session_id = local_link.as_ref().and_then(runtime_session_id_from_link);
        let requested_session_id = runtime_session_id_from_payload(&payload);
        let direct_thread_override = requested_session_id
            .as_deref()
            .zip(linked_session_id.as_deref())
            .is_some_and(|(requested, linked)| requested != linked);
        let session_id = requested_session_id.or(linked_session_id);
        let running_hint = local_link.as_ref().is_some_and(|link| link.running);
        let local_execution_running = self.is_active_local_task(&local_task_id);
        if navigation_only {
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
            let metadata_response = self
                .codex_app_server
                .request(
                    "thread/read",
                    json!({"threadId": thread_id, "includeTurns": false}),
                )
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
            let prefer_rollout_history = local_link.as_ref().is_some_and(|link| {
                link.runtime_handle
                    .get("cloudTranscript")
                    .is_some_and(Value::is_object)
            });
            let navigation = self
                .codex_transcript_navigation(&thread, &thread_id, prefer_rollout_history, refresh)
                .await?;
            return Ok(transcript_navigation_response(
                local_task_id,
                workspace_path,
                transcript_navigation_from_codex_turns(navigation),
            ));
        }
        if local_execution_running && !refresh && !direct_thread_override {
            if let Some(link) = local_link
                .as_ref()
                .filter(|link| runtime_has_provider_transcript_reader(&link.runtime))
            {
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
        }) {
            let mut messages = cached_runtime_transcript_messages(link);
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

        if refresh && !local_execution_running && !direct_thread_override {
            if let Some(link) = local_link.as_ref().filter(|link| !link.ephemeral) {
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

        let CodexTranscriptPage {
            mut thread,
            before_cursor: page_before_cursor,
            after_cursor: page_after_cursor,
            prepend_item_turn_ids,
        } = load_codex_transcript(
            &self.codex_app_server,
            CodexTranscriptRequest {
                thread_id: &thread_id,
                cursor: before_cursor.as_deref().or(after_cursor.as_deref()),
                limit: limit
                    .filter(|value| *value > 0)
                    .unwrap_or(CODEX_TRANSCRIPT_PAGE_SIZE)
                    .min(CODEX_TRANSCRIPT_PAGE_SIZE),
                direction: if after_cursor.is_some() {
                    CodexTranscriptDirection::Ascending
                } else {
                    CodexTranscriptDirection::Descending
                },
                full_content: include_full_content,
                prefer_rollout_history: local_link.as_ref().is_some_and(|link| {
                    link.runtime_handle
                        .get("cloudTranscript")
                        .is_some_and(Value::is_object)
                }),
            },
        )
        .await
        .map_err(|error| AppIpcError::new("codex_error", error))?;
        if let Some(workspace_path) = local_link
            .as_ref()
            .map(|link| link.workspace_path.as_str())
            .filter(|path| !path.is_empty())
        {
            if let Some(thread) = thread.as_object_mut() {
                thread.insert("cwd".to_owned(), Value::String(workspace_path.to_owned()));
            }
        }
        let presentation_page_turn_ids = thread
            .get("turns")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|turn| string_field(turn, "id"))
            .collect::<Vec<_>>();
        let presentation_page_messages = local_link
            .as_ref()
            .filter(|_| !direct_thread_override)
            .map(|_| {
                if include_full_content {
                    full_transcript_messages(&thread, &self.device_id)
                } else {
                    transcript_messages(&thread, &self.device_id)
                }
            });
        if !direct_thread_override {
            self.merge_active_codex_transcript(&local_task_id, &mut thread);
            self.repair_legacy_task_activity_time(&local_task_id, &thread);
        }
        let workspace_path = local_link
            .as_ref()
            .map(|link| link.workspace_path.clone())
            .filter(|path| !path.trim().is_empty())
            .or_else(|| string_field(&thread, "cwd"))
            .or_else(|| string_field(&payload, "workspacePath"))
            .or_else(|| string_field(&payload, "workspace_path"))
            .unwrap_or_default();

        let context_usage = transcript_context_usage(&thread);
        let transcript_messages = if include_full_content {
            full_transcript_messages(&thread, &self.device_id)
        } else {
            transcript_messages(&thread, &self.device_id)
        };
        let mut messages = transcript_messages;
        if let Some(link) = local_link.as_ref().filter(|_| !direct_thread_override) {
            merge_latest_completed_transcript_messages(
                &mut messages,
                link,
                before_cursor.as_deref(),
                after_cursor.as_deref(),
            );
            attach_user_message_presentations_for_page(
                &mut messages,
                user_message_presentations(link),
                presentation_page_messages.as_deref().unwrap_or_default(),
                &presentation_page_turn_ids,
                page_before_cursor.is_some(),
                page_after_cursor.is_some(),
            );
            remove_superseded_transcript_turns(&mut messages, &link.runtime_handle);
        }
        attach_legacy_thread_preview(&mut messages, &thread, page_before_cursor.is_some());
        if before_cursor.is_none() && after_cursor.is_none() && !include_full_content {
            let snapshot_changed = local_link.as_ref().is_some_and(|link| {
                link.thread_id.as_deref() == Some(thread_id.as_str())
                    && transcript_snapshot_messages(link) != messages
            });
            if snapshot_changed {
                let snapshot_messages = messages.clone();
                self.store.update_task(&local_task_id, |link| {
                    if link.thread_id.as_deref() == Some(thread_id.as_str()) {
                        set_transcript_snapshot_messages(
                            &mut link.runtime_handle,
                            &thread_id,
                            snapshot_messages,
                        );
                    }
                });
            }
        }
        let running = local_execution_running || codex_thread_has_in_progress_turn(&thread);
        let message_count = messages.len();
        let turn_navigation = if include_full_content
            || (before_cursor.is_none() && after_cursor.is_none() && page_before_cursor.is_none())
        {
            transcript_turn_navigation(&messages)
        } else {
            Vec::new()
        };
        log_runtime_transcript_finished(RuntimeTranscriptLog {
            started_at,
            local_task_id: &local_task_id,
            thread_id: &thread_id,
            source: "thread_pagination",
            refresh,
            running_hint,
            limit,
            before_cursor: before_cursor.as_deref(),
            after_cursor: after_cursor.as_deref(),
            message_count,
            running,
        });

        let mut response = transcript_response(TranscriptResponseInput {
            local_task_id,
            workspace_path,
            runtime: "codex".to_owned(),
            messages,
            context_usage,
            running,
            pagination: TranscriptPagination::Opaque {
                before_cursor: if include_full_content {
                    None
                } else {
                    page_before_cursor
                },
                after_cursor: if include_full_content {
                    None
                } else {
                    page_after_cursor
                },
            },
            full_content: include_full_content,
            conversation_context_only,
            turn_item_source: TranscriptTurnItemSource::CodexItems,
            turn_navigation,
        });
        mark_prepend_item_turns(&mut response, &prepend_item_turn_ids);
        Ok(response)
    }

    async fn codex_transcript_navigation(
        &self,
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

        let navigation = load_codex_transcript_navigation(
            &self.codex_app_server,
            thread,
            thread_id,
            prefer_rollout_history,
        )
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

fn mark_prepend_item_turns(response: &mut Value, turn_ids: &HashSet<String>) {
    if turn_ids.is_empty() {
        return;
    }
    for turn in response
        .get_mut("turns")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let Some(turn_id) = string_field(turn, "id") else {
            continue;
        };
        if turn_ids.contains(&turn_id) {
            turn["itemMerge"] = Value::String("prepend".to_owned());
        }
    }
}
