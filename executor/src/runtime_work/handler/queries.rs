// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn list_tasks(&self) -> Result<Value, AppIpcError> {
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
        let stage_started_at = Instant::now();
        let collected_links = self.collect_links(false).await;
        log_runtime_work_list_diagnostic(
            "links_collected",
            started_at,
            stage_started_at,
            &[("links", collected_links.len().to_string())],
        );
        let stage_started_at = Instant::now();
        let links = self.visible_links_for_projects(collected_links, &project_index);
        log_runtime_work_list_diagnostic(
            "project_filter_applied",
            started_at,
            stage_started_at,
            &[("visible_links", links.len().to_string())],
        );
        let stage_started_at = Instant::now();
        let workspaces = workspace_response(links, codex_project_workspaces(&project_index));
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
        Ok(json!({
            "success": true,
            "workspaces": workspaces,
        }))
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
            let Some(thread_id) = link.thread_id.as_deref() else {
                continue;
            };
            let messages = self.thread_messages(thread_id).await;
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
        let started_at = Instant::now();
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let limit = transcript_limit(&payload);
        let before_cursor = string_field(&payload, "beforeCursor")
            .or_else(|| string_field(&payload, "before_cursor"));
        let after_cursor = string_field(&payload, "afterCursor")
            .or_else(|| string_field(&payload, "after_cursor"));
        let include_full_content = bool_field(&payload, "includeFullContent")
            .or_else(|| bool_field(&payload, "include_full_content"))
            .unwrap_or(false);
        let refresh = bool_field(&payload, "refresh")
            .or_else(|| bool_field(&payload, "forceRefresh"))
            .unwrap_or(false);
        let local_link = self.local_task_link(&local_task_id);
        let session_id = local_link
            .as_ref()
            .and_then(runtime_session_id_from_link)
            .or_else(|| runtime_session_id_from_payload(&payload));
        let running_hint = local_link.as_ref().is_some_and(|link| link.running);
        let local_execution_running = self.is_active_local_task(&local_task_id);
        if let Some(link) = local_link.as_ref().filter(|link| {
            !runtime_has_provider_transcript_reader(&link.runtime) || session_id.is_none()
        }) {
            let messages = cached_runtime_transcript_messages(link);
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

        let Some(thread_id) = session_id else {
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
            return Ok(transcript_response(TranscriptResponseInput {
                local_task_id,
                workspace_path,
                runtime,
                messages: Vec::new(),
                context_usage: None,
                running: local_execution_running,
                limit,
                before_cursor,
                after_cursor,
                full_content: include_full_content,
            }));
        };

        let response = self
            .codex_app_server
            .request(
                "thread/read",
                json!({"threadId": thread_id.clone(), "includeTurns": true}),
            )
            .await
            .map_err(|error| AppIpcError::new("codex_error", error))?;
        let thread = response.get("thread").unwrap_or(&response).clone();
        self.repair_legacy_task_activity_time(&local_task_id, &thread);
        let workspace_path = string_field(&thread, "cwd")
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
        if local_link.as_ref().is_some_and(|link| link.running) {
            append_missing_cached_user_messages(
                &mut messages,
                local_link.as_ref().map(cached_messages).unwrap_or_default(),
            );
        } else if local_link
            .as_ref()
            .is_some_and(|link| link.status.eq_ignore_ascii_case("failed"))
        {
            let cached = local_link.as_ref().map(cached_messages).unwrap_or_default();
            append_missing_cached_user_messages(&mut messages, cached.clone());
            append_missing_cached_failed_assistant_messages(&mut messages, cached);
        }
        let running = local_execution_running;
        let message_count = messages.len();
        log_runtime_transcript_finished(RuntimeTranscriptLog {
            started_at,
            local_task_id: &local_task_id,
            thread_id: &thread_id,
            source: "thread_read",
            refresh,
            running_hint,
            limit,
            before_cursor: before_cursor.as_deref(),
            after_cursor: after_cursor.as_deref(),
            message_count,
            running,
        });

        Ok(transcript_response(TranscriptResponseInput {
            local_task_id,
            workspace_path,
            runtime: "codex".to_owned(),
            messages,
            context_usage,
            running,
            limit: if include_full_content { None } else { limit },
            before_cursor: if include_full_content {
                None
            } else {
                before_cursor
            },
            after_cursor: if include_full_content {
                None
            } else {
                after_cursor
            },
            full_content: include_full_content,
        }))
    }
}
