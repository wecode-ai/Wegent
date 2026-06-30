// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashSet,
    future::Future,
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Instant,
};

use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, mpsc};

use crate::{
    agents::{run_codex_app_server_turn, CodexAppServerClient, CodexNotificationSender},
    local::app_ipc::{AppIpcError, RuntimeWorkHandler},
    logging::log_executor_event,
    protocol::ExecutionRequest,
    runner::ExecutionOutcome,
};

use super::{
    codex_global_state::{
        ensure_codex_global_project, remove_codex_global_project, rename_codex_global_project,
        CodexGlobalProjectIndex,
    },
    codex_rollout::{
        append_rollout_turns_from_offset, rollout_turns, thread_with_rollout_running_status,
        thread_with_rollout_turns, thread_with_turns,
    },
    events::{emit_response_event, CodexNotificationEventMapper},
    response::{
        archived_conversations_response, search_result_item, workspace_response, RuntimeTaskLink,
        RuntimeWorkspaceLink, SearchResultMatch,
    },
    runtime_handle_messages::{
        append_runtime_handle_message, cached_messages, merge_cached_messages,
        retain_runtime_handle_user_messages, set_runtime_handle_messages,
        CodexNotificationCacheMapper,
    },
    store::RuntimeWorkStore,
    transcript::transcript_messages,
    transcript_cache::{CachedTranscript, TranscriptCache, TranscriptSourceSignature},
    transcript_page::transcript_page,
    util::{
        apply_runtime_payload_metadata, bool_field, execution_request,
        execution_request_from_payload, integer_field, normalize_device_id, now_ms, prompt_text,
        runtime_task_id, string_field, workspace_group_path, workspace_path,
    },
};

const CODEX_THREAD_LIST_PAGE_SIZE: usize = 100;
const CODEX_THREAD_LIST_MAX_ITEMS: usize = 500;
const CODEX_THREAD_LIST_CACHE_TTL_MS: i64 = 1_500;
const CODEX_THREAD_SOURCE_KINDS: &[&str] = &["cli", "vscode", "exec", "appServer"];
const TRANSCRIPT_NAVIGATION_PREVIEW_CHARS: usize = 96;

#[derive(Clone)]
pub struct RuntimeWorkRpcHandler {
    device_id: String,
    codex_binary: String,
    codex_app_server: CodexAppServerClient,
    event_tx: Option<broadcast::Sender<Value>>,
    active_local_tasks: Arc<Mutex<HashSet<String>>>,
    store: RuntimeWorkStore,
    transcript_cache: TranscriptCache,
    thread_list_cache: CodexThreadListCache,
}

impl RuntimeWorkRpcHandler {
    pub fn new(device_id: impl Into<String>, codex_binary: impl Into<String>) -> Self {
        let codex_binary = codex_binary.into();
        Self {
            device_id: normalize_device_id(device_id.into()),
            codex_binary: codex_binary.clone(),
            codex_app_server: CodexAppServerClient::new(codex_binary),
            event_tx: None,
            active_local_tasks: Arc::new(Mutex::new(HashSet::new())),
            store: RuntimeWorkStore::from_env(),
            transcript_cache: TranscriptCache::default(),
            thread_list_cache: CodexThreadListCache::default(),
        }
    }

    pub fn with_event_sender(
        device_id: impl Into<String>,
        codex_binary: impl Into<String>,
        event_tx: broadcast::Sender<Value>,
    ) -> Self {
        Self {
            event_tx: Some(event_tx),
            ..Self::new(device_id, codex_binary)
        }
    }

    async fn dispatch(&self, method: &str, payload: Value) -> Result<Value, AppIpcError> {
        match method {
            "runtime.tasks.list" => self.list_tasks().await,
            "runtime.tasks.search" => self.search_tasks(payload).await,
            "runtime.tasks.transcript" => self.transcript(payload).await,
            "runtime.tasks.create" => self.create_task(payload).await,
            "runtime.tasks.send" => self.send_message(payload).await,
            "runtime.tasks.prepare_fork_transfer" => self.prepare_fork_transfer(payload).await,
            "runtime.tasks.import_fork" => self.import_fork(payload).await,
            "runtime.tasks.archive" => self.archive_task(payload).await,
            "runtime.tasks.rename" => self.rename_task(payload).await,
            "runtime.tasks.cancel" => self.cancel_task(payload).await,
            "runtime.archived_conversations.list" => {
                self.list_archived_conversations(payload).await
            }
            "runtime.archived_conversations.unarchive" => self.unarchive_task(payload).await,
            "runtime.archived_conversations.delete" => self.delete_archived_task(payload).await,
            "runtime.archived_conversations.delete_bulk" => {
                self.delete_archived_tasks_bulk(payload).await
            }
            "runtime.workspaces.open" => self.open_workspace(payload).await,
            "runtime.workspaces.rename" => self.rename_workspace(payload).await,
            "runtime.workspaces.remove" => self.remove_workspace(payload).await,
            unsupported => Err(AppIpcError::new(
                "unsupported_method",
                format!("Unsupported runtime RPC method: {unsupported}"),
            )),
        }
    }

    async fn list_tasks(&self) -> Result<Value, AppIpcError> {
        let started_at = Instant::now();
        let project_index = CodexGlobalProjectIndex::load();
        let links =
            self.visible_links_for_projects(self.collect_links(false).await, &project_index);
        let workspaces = workspace_response(links, codex_project_workspaces(&project_index));
        let local_task_count = workspaces
            .iter()
            .filter_map(|workspace| workspace.get("localTasks").and_then(Value::as_array))
            .map(Vec::len)
            .sum::<usize>();
        log_executor_event(
            "runtime work list finished",
            &[
                ("elapsed_ms", elapsed_ms(started_at)),
                ("workspaces", workspaces.len().to_string()),
                ("local_tasks", local_task_count.to_string()),
            ],
        );
        Ok(json!({
            "success": true,
            "workspaces": workspaces,
        }))
    }

    async fn list_archived_conversations(&self, payload: Value) -> Result<Value, AppIpcError> {
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

    async fn search_tasks(&self, payload: Value) -> Result<Value, AppIpcError> {
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

    async fn transcript(&self, payload: Value) -> Result<Value, AppIpcError> {
        let started_at = Instant::now();
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "localTaskId is required"))?;
        let limit = transcript_limit(&payload);
        let before_cursor = string_field(&payload, "beforeCursor")
            .or_else(|| string_field(&payload, "before_cursor"));
        let after_cursor = string_field(&payload, "afterCursor")
            .or_else(|| string_field(&payload, "after_cursor"));
        let refresh = bool_field(&payload, "refresh")
            .or_else(|| bool_field(&payload, "forceRefresh"))
            .unwrap_or(false);
        let local_link = self.local_task_link(&local_task_id);
        let session_id = local_link
            .as_ref()
            .and_then(runtime_session_id_from_link)
            .or_else(|| runtime_session_id_from_payload(&payload));
        let running_hint = local_link.as_ref().is_some_and(|link| link.running);
        if let Some(link) = local_link.as_ref().filter(|link| {
            !runtime_has_provider_transcript_reader(&link.runtime) || session_id.is_none()
        }) {
            let messages = cached_messages(link);
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
                running: false,
            });
            return Ok(transcript_response(
                &local_task_id,
                workspace_path,
                runtime,
                Vec::new(),
                limit,
                before_cursor.as_deref(),
                after_cursor.as_deref(),
            ));
        };

        if let Some(cached) = self.transcript_cache.get(&thread_id, running_hint, refresh) {
            let messages = local_link
                .as_ref()
                .map(|link| merge_cached_messages(cached.messages.clone(), cached_messages(link)))
                .unwrap_or_else(|| cached.messages.clone());
            log_runtime_transcript_finished(RuntimeTranscriptLog {
                started_at,
                local_task_id: &local_task_id,
                thread_id: &thread_id,
                source: "transcript_cache",
                refresh,
                running_hint,
                limit,
                before_cursor: before_cursor.as_deref(),
                after_cursor: after_cursor.as_deref(),
                message_count: messages.len(),
                running: cached.running,
            });
            return Ok(transcript_response(
                &local_task_id,
                cached.workspace_path,
                cached.runtime,
                messages,
                limit,
                before_cursor.as_deref(),
                after_cursor.as_deref(),
            ));
        }

        let mut source = "thread_read";
        let thread = match self.cached_codex_thread_for_transcript(&thread_id) {
            Some(thread) => {
                source = "thread_list_rollout";
                thread
            }
            None => {
                let response = self
                    .codex_app_server
                    .request(
                        "thread/read",
                        json!({"threadId": thread_id.clone(), "includeTurns": false}),
                    )
                    .await
                    .map_err(|error| AppIpcError::new("codex_error", error))?;
                response.get("thread").unwrap_or(&response).clone()
            }
        };
        let workspace_path = string_field(&thread, "cwd")
            .or_else(|| string_field(&payload, "workspacePath"))
            .or_else(|| string_field(&payload, "workspace_path"))
            .unwrap_or_default();

        if refresh {
            if let Some(cached) = self.transcript_cache.peek(&thread_id) {
                if let Some(updated) = self.incremental_cached_transcript(
                    cached,
                    &thread,
                    local_link.as_ref(),
                    running_hint,
                    &workspace_path,
                ) {
                    let messages = updated.messages.clone();
                    let running = updated.running;
                    self.transcript_cache.insert(thread_id.clone(), updated);
                    log_runtime_transcript_finished(RuntimeTranscriptLog {
                        started_at,
                        local_task_id: &local_task_id,
                        thread_id: &thread_id,
                        source: "incremental_rollout",
                        refresh,
                        running_hint,
                        limit,
                        before_cursor: before_cursor.as_deref(),
                        after_cursor: after_cursor.as_deref(),
                        message_count: messages.len(),
                        running,
                    });
                    return Ok(transcript_response(
                        &local_task_id,
                        workspace_path,
                        "codex".to_owned(),
                        messages,
                        limit,
                        before_cursor.as_deref(),
                        after_cursor.as_deref(),
                    ));
                }
            }
        }

        let transcript_thread = codex_thread_state(&thread);
        let messages = local_link
            .as_ref()
            .map(|link| {
                merge_cached_messages(
                    transcript_messages(&transcript_thread, &self.device_id),
                    cached_messages(link),
                )
            })
            .unwrap_or_else(|| transcript_messages(&transcript_thread, &self.device_id));
        let running = running_hint || messages.iter().any(runtime_message_running);
        let message_count = messages.len();
        self.transcript_cache.insert(
            thread_id.clone(),
            CachedTranscript::new(
                workspace_path.clone(),
                "codex".to_owned(),
                messages.clone(),
                running,
                transcript_source_signature(&thread),
            )
            .with_rollout_turns(rollout_turns(&transcript_thread)),
        );
        log_runtime_transcript_finished(RuntimeTranscriptLog {
            started_at,
            local_task_id: &local_task_id,
            thread_id: &thread_id,
            source,
            refresh,
            running_hint,
            limit,
            before_cursor: before_cursor.as_deref(),
            after_cursor: after_cursor.as_deref(),
            message_count,
            running,
        });

        Ok(transcript_response(
            &local_task_id,
            workspace_path,
            "codex".to_owned(),
            messages,
            limit,
            before_cursor.as_deref(),
            after_cursor.as_deref(),
        ))
    }

    async fn archive_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let mut link = self.task_link_from_payload(&payload, false).await?;
        if let Some(thread_id) = link.thread_id.as_deref() {
            if let Err(error) = self
                .call_codex_thread_method("thread/archive", json!({"threadId": thread_id}))
                .await
            {
                return Ok(task_action_failure(&link, error));
            }
        }

        link.status = "archived".to_owned();
        link.running = false;
        link.updated_at = now_ms();
        self.upsert_local_task(link.clone());
        Ok(task_action_success(&link))
    }

    async fn unarchive_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let mut link = self.task_link_from_payload(&payload, true).await?;
        if let Some(thread_id) = link.thread_id.as_deref() {
            if let Err(error) = self
                .call_codex_thread_method("thread/unarchive", json!({"threadId": thread_id}))
                .await
            {
                return Ok(task_action_failure(&link, error));
            }
        }

        link.status = "active".to_owned();
        link.running = false;
        link.updated_at = now_ms();
        self.upsert_local_task(link.clone());
        Ok(task_action_success(&link))
    }

    async fn rename_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let title = string_field(&payload, "title")
            .or_else(|| string_field(&payload, "name"))
            .ok_or_else(|| AppIpcError::new("bad_request", "title is required"))?;
        let mut link = self.task_link_from_payload(&payload, false).await?;
        if let Some(thread_id) = link.thread_id.as_deref() {
            if let Err(error) = self
                .call_codex_thread_method(
                    "thread/name/set",
                    json!({"threadId": thread_id, "name": title}),
                )
                .await
            {
                return Ok(task_action_failure(&link, error));
            }
        }

        link.title = title;
        link.updated_at = now_ms();
        self.upsert_local_task(link.clone());
        let mut response = task_action_success(&link);
        response["codexRename"] = json!({"stateUpdated": true});
        Ok(response)
    }

    async fn delete_archived_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let link = self.task_link_from_payload(&payload, true).await?;
        if let Some(thread_id) = link.thread_id.as_deref() {
            if let Err(error) = self
                .call_codex_thread_method("thread/delete", json!({"threadId": thread_id}))
                .await
            {
                return Ok(task_action_failure(&link, error));
            }
        }

        self.store.delete_task(&link.local_task_id);
        let mut response = task_action_success(&link);
        response["deleted"] = json!(true);
        Ok(response)
    }

    async fn delete_archived_tasks_bulk(&self, payload: Value) -> Result<Value, AppIpcError> {
        let items = payload
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut results = Vec::new();
        let mut deleted_count = 0;
        for item in items {
            let result = self.delete_archived_task(item).await?;
            if result["deleted"] == true {
                deleted_count += 1;
            }
            results.push(result);
        }

        Ok(json!({
            "success": true,
            "accepted": true,
            "requestedCount": results.len(),
            "acceptedCount": deleted_count,
            "deletedCount": deleted_count,
            "results": results,
        }))
    }

    async fn create_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = string_field(&payload, "localTaskId")
            .or_else(|| string_field(&payload, "local_task_id"))
            .unwrap_or_else(|| format!("codex-local-{}", now_ms()));
        let workspace_path = workspace_path(&payload)
            .or_else(|| {
                execution_request(&payload).and_then(|request| request.cwd().map(str::to_owned))
            })
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let title = string_field(&payload, "title")
            .or_else(|| string_field(&payload, "message"))
            .unwrap_or_else(|| local_task_id.clone());
        let mut request = match execution_request(&payload) {
            Some(request) => request,
            None => execution_request_from_payload(&payload, &workspace_path)
                .map_err(|message| AppIpcError::new("bad_request", message))?,
        };
        apply_runtime_payload_metadata(&mut request, &payload);

        let mut link = RuntimeTaskLink::new_pending(
            local_task_id.clone(),
            workspace_path.clone(),
            title.clone(),
        );
        if let Some(message) = cached_user_message(&local_task_id, &request, &payload) {
            set_runtime_handle_messages(&mut link.runtime_handle, vec![message]);
        }
        self.upsert_local_task(link);
        self.spawn_turn(local_task_id.clone(), request, None, Some(title));

        Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": self.device_id,
            "localTaskId": local_task_id,
            "runtime": "codex",
        }))
    }

    async fn send_message(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "localTaskId is required"))?;
        let existing_link = self.local_task_link(&local_task_id);
        let payload_execution_request = execution_request(&payload);
        let has_execution_request = payload_execution_request.is_some();
        if existing_link.as_ref().is_some_and(|link| link.running) {
            return Ok(json!({
                "success": false,
                "error": "runtime task is already running",
                "code": "bad_request",
            }));
        }
        let workspace_path = workspace_path(&payload)
            .or_else(|| {
                existing_link
                    .as_ref()
                    .map(|link| link.workspace_path.clone())
            })
            .unwrap_or_default();
        let mut request = match payload_execution_request {
            Some(request) => request,
            None => execution_request_from_payload(&payload, &workspace_path)
                .map_err(|message| AppIpcError::new("bad_request", message))?,
        };
        apply_runtime_payload_metadata(&mut request, &payload);
        request.new_session = false;
        if request.project_workspace_path.is_none() && !workspace_path.is_empty() {
            request.project_workspace_path = Some(workspace_path.clone());
        }
        let Some(thread_id) = runtime_session_id_from_payload(&payload).or_else(|| {
            existing_link
                .as_ref()
                .and_then(runtime_session_id_from_link)
        }) else {
            return Ok(json!({
                "success": false,
                "error": "runtime task session is not ready",
                "code": "missing_runtime_session",
                "localTaskId": local_task_id,
                "runtime": "codex",
            }));
        };

        let mut fields = task_fields(request.task_id, request.subtask_id);
        fields.push(("local_task_id", local_task_id.clone()));
        fields.push(("thread_id", thread_id.clone()));
        fields.push(("workspace_path", workspace_path.clone()));
        fields.push(("has_execution_request", has_execution_request.to_string()));
        fields.push(("prompt_len", prompt_text(&request.prompt).len().to_string()));
        if let Some(cwd) = request.cwd() {
            fields.push(("cwd", cwd.to_owned()));
        }
        fields.push((
            "model_id",
            string_field(&request.model_config, "model_id")
                .or_else(|| string_field(&request.model_config, "modelId"))
                .unwrap_or_default(),
        ));
        log_executor_event("runtime work send prepared", &fields);

        self.mark_task_running_for_send(
            &local_task_id,
            &thread_id,
            &workspace_path,
            &request,
            &payload,
        );
        self.spawn_turn(local_task_id.clone(), request, Some(thread_id), None);

        Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": self.device_id,
            "localTaskId": local_task_id,
            "runtime": "codex",
        }))
    }

    async fn cancel_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "localTaskId is required"))?;
        let link = self
            .store
            .update_task(&local_task_id, |link| {
                link.status = "cancelled".to_owned();
                link.running = false;
                link.updated_at = now_ms();
            })
            .or_else(|| self.local_task_link(&local_task_id));

        Ok(match link {
            Some(link) => task_action_success(&link),
            None => json!({
                "success": true,
                "accepted": true,
                "localTaskId": local_task_id,
                "runtime": "codex",
            }),
        })
    }

    fn mark_task_running_for_send(
        &self,
        local_task_id: &str,
        thread_id: &str,
        workspace_path: &str,
        request: &ExecutionRequest,
        payload: &Value,
    ) {
        let message = cached_user_message(local_task_id, request, payload);
        let updated = self.store.update_task(local_task_id, |link| {
            link.thread_id = Some(thread_id.to_owned());
            link.workspace_path = workspace_path.to_owned();
            link.status = "running".to_owned();
            link.running = true;
            link.updated_at = now_ms();
            if let Some(message) = message.clone() {
                append_runtime_handle_message(&mut link.runtime_handle, message);
            }
        });
        if updated.is_some() {
            return;
        }

        let mut link = RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            workspace_path.to_owned(),
            prompt_text(&request.prompt),
        );
        link.thread_id = Some(thread_id.to_owned());
        if let Some(message) = message {
            set_runtime_handle_messages(&mut link.runtime_handle, vec![message]);
        }
        self.upsert_local_task(link);
    }

    async fn open_workspace(&self, payload: Value) -> Result<Value, AppIpcError> {
        if !payload_runtime_is_codex(&payload) {
            return Ok(json!({
                "success": false,
                "error": "Only Codex runtime workspaces can be opened without a turn",
                "code": "unsupported_runtime",
            }));
        }
        let workspace_path = workspace_path(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let label = string_field(&payload, "label").or_else(|| string_field(&payload, "name"));
        let project = ensure_codex_global_project(&workspace_path, label.as_deref())
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;

        Ok(json!({
            "success": true,
            "accepted": true,
            "workspacePath": project.workspace_path,
            "runtime": "codex",
        }))
    }

    async fn rename_workspace(&self, payload: Value) -> Result<Value, AppIpcError> {
        if !payload_runtime_is_codex(&payload) {
            return Ok(json!({
                "success": false,
                "error": "Only Codex runtime workspaces can be renamed without a turn",
                "code": "unsupported_runtime",
            }));
        }
        let workspace_path = workspace_path(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let label = string_field(&payload, "label")
            .or_else(|| string_field(&payload, "name"))
            .ok_or_else(|| AppIpcError::new("bad_request", "label is required"))?;
        let project = rename_codex_global_project(&workspace_path, &label)
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;

        Ok(json!({
            "success": true,
            "accepted": true,
            "workspacePath": project.workspace_path,
            "runtime": "codex",
        }))
    }

    async fn remove_workspace(&self, payload: Value) -> Result<Value, AppIpcError> {
        if !payload_runtime_is_codex(&payload) {
            return Ok(json!({
                "success": false,
                "error": "Only Codex runtime workspaces can be removed without a turn",
                "code": "unsupported_runtime",
            }));
        }
        let workspace_path = workspace_path(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let workspace_path = remove_codex_global_project(&workspace_path)
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;

        Ok(json!({
            "success": true,
            "accepted": true,
            "workspacePath": workspace_path,
            "runtime": "codex",
        }))
    }

    async fn prepare_fork_transfer(&self, payload: Value) -> Result<Value, AppIpcError> {
        let transfer = match super::fork_transfer::validate_prepare_transfer_payload(&payload) {
            Ok(transfer) => transfer,
            Err(error) => return Ok(fork_error_response(error.code(), error.to_string())),
        };
        let workspace_path = workspace_path(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let link = self.task_link_from_payload(&payload, false).await?;
        let include_workspace = transfer.workspace_transfer.as_deref() == Some("git_workspace");
        let mut archive = Map::new();
        archive.insert(
            "mode".to_owned(),
            Value::String(
                if include_workspace {
                    "git_workspace"
                } else {
                    "session_only"
                }
                .to_owned(),
            ),
        );
        archive.insert("transferId".to_owned(), Value::String(transfer.transfer_id));
        archive.insert(
            "requiresWorkspaceRestore".to_owned(),
            Value::Bool(include_workspace),
        );
        archive.insert("directUrls".to_owned(), Value::Array(Vec::new()));

        Ok(json!({
            "success": true,
            "accepted": true,
            "workspacePath": workspace_path,
            "localTaskId": link.local_task_id,
            "package": {
                "sourceRuntime": link.runtime,
                "title": link.title,
                "runtimeHandle": runtime_handle_json(&link),
                "recentMessages": cached_messages(&link),
                "archive": Value::Object(archive),
            }
        }))
    }

    async fn import_fork(&self, payload: Value) -> Result<Value, AppIpcError> {
        let import = match super::fork_transfer::validate_import_fork_payload(&payload) {
            Ok(import) => import,
            Err(error) => return Ok(fork_error_response(error.code(), error.to_string())),
        };
        let runtime = string_field(&import.fork_package, "sourceRuntime")
            .or_else(|| string_field(&import.fork_package, "source_runtime"))
            .unwrap_or_else(|| "codex".to_owned());
        if runtime.eq_ignore_ascii_case("codex") {
            return Ok(json!({
                "success": false,
                "error": "Codex fork imports must restore into native Codex, not runtime index",
                "code": "bad_request",
            }));
        }
        let runtime_handle =
            match super::fork_transfer::build_imported_runtime_handle(&import.fork_package) {
                Ok(runtime_handle) => runtime_handle,
                Err(error) => return Ok(fork_error_response(error.code(), error.to_string())),
            };
        let local_task_id = format!("runtime-fork-{}", now_ms());
        let title = string_field(&import.fork_package, "title")
            .unwrap_or_else(|| "Forked runtime task".to_owned());
        let parent = source_parent_json(&import.source);
        let link = RuntimeTaskLink::new_imported(
            local_task_id.clone(),
            import.workspace_path,
            title,
            runtime,
            runtime_handle,
            parent,
        );
        self.upsert_local_task(link.clone());
        Ok(task_action_success(&link))
    }

    fn spawn_turn(
        &self,
        local_task_id: String,
        request: ExecutionRequest,
        resume_thread_id: Option<String>,
        initial_thread_name: Option<String>,
    ) {
        let mut fields = task_fields(request.task_id, request.subtask_id);
        fields.push(("local_task_id", local_task_id.clone()));
        fields.push(("resume", resume_thread_id.is_some().to_string()));
        if let Some(thread_id) = &resume_thread_id {
            fields.push(("thread_id", thread_id.clone()));
        }
        if let Some(cwd) = request.cwd() {
            fields.push(("cwd", cwd.to_owned()));
        }
        log_executor_event("runtime work turn spawning", &fields);

        self.mark_active_local_task(&local_task_id);
        let handler = self.clone();
        tokio::spawn(async move {
            emit_response_event(
                &handler.event_tx,
                &handler.device_id,
                "response.created",
                &local_task_id,
                &request,
                json!({"response": {"status": "in_progress"}}),
            );

            let (notifications, mapper_task) =
                handler.spawn_notification_mapper(local_task_id.clone(), request.clone());
            let result = run_codex_app_server_turn(
                &handler.codex_binary,
                request.clone(),
                resume_thread_id,
                initial_thread_name,
                notifications,
            )
            .await;
            if let Err(error) = mapper_task.await {
                log_executor_event(
                    "runtime work notification mapper failed",
                    &[
                        ("local_task_id", local_task_id.clone()),
                        ("error", error.to_string()),
                    ],
                );
            }

            handler.handle_turn_result(&local_task_id, &request, result);
        });
    }

    fn handle_turn_result(
        &self,
        local_task_id: &str,
        request: &ExecutionRequest,
        result: Result<crate::agents::CodexAppServerTurn, String>,
    ) {
        match result {
            Ok(turn) => {
                let status = match &turn.outcome {
                    ExecutionOutcome::Completed { .. } => "done",
                    ExecutionOutcome::WaitingForUserInput { .. } => "done",
                    ExecutionOutcome::Cancelled { .. } => "cancelled",
                    ExecutionOutcome::Failed { .. } => "failed",
                    ExecutionOutcome::Running => "running",
                };
                self.finish_local_task(local_task_id, Some(turn.thread_id), status);
                match turn.outcome {
                    ExecutionOutcome::Completed { content } => emit_response_event(
                        &self.event_tx,
                        &self.device_id,
                        "response.completed",
                        local_task_id,
                        request,
                        json!({"value": content}),
                    ),
                    ExecutionOutcome::WaitingForUserInput { stop_reason } => emit_response_event(
                        &self.event_tx,
                        &self.device_id,
                        "response.completed",
                        local_task_id,
                        request,
                        json!({
                            "value": "",
                            "stop_reason": stop_reason,
                            "silent_exit": true,
                            "silent_exit_reason": "waiting_for_user_input"
                        }),
                    ),
                    ExecutionOutcome::Cancelled { message } => emit_response_event(
                        &self.event_tx,
                        &self.device_id,
                        "response.incomplete",
                        local_task_id,
                        request,
                        json!({"error": {"message": message}}),
                    ),
                    ExecutionOutcome::Failed { message } => {
                        let mut fields = task_fields(request.task_id, request.subtask_id);
                        fields.push(("local_task_id", local_task_id.to_owned()));
                        fields.push(("error", message.clone()));
                        fields.push(("error_len", message.len().to_string()));
                        log_executor_event("runtime work turn failed", &fields);
                        emit_response_event(
                            &self.event_tx,
                            &self.device_id,
                            "response.failed",
                            local_task_id,
                            request,
                            json!({"error": {"message": message}}),
                        );
                    }
                    ExecutionOutcome::Running => {}
                }
            }
            Err(error) => {
                self.finish_local_task(local_task_id, None, "failed");
                let mut fields = task_fields(request.task_id, request.subtask_id);
                fields.push(("local_task_id", local_task_id.to_owned()));
                fields.push(("error", error.clone()));
                fields.push(("error_len", error.len().to_string()));
                log_executor_event("runtime work turn failed", &fields);
                emit_response_event(
                    &self.event_tx,
                    &self.device_id,
                    "response.failed",
                    local_task_id,
                    request,
                    json!({"error": {"message": error}}),
                );
            }
        }
    }

    fn spawn_notification_mapper(
        &self,
        local_task_id: String,
        request: ExecutionRequest,
    ) -> (Option<CodexNotificationSender>, tokio::task::JoinHandle<()>) {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let event_tx = self.event_tx.clone();
        let device_id = self.device_id.clone();
        let store = self.store.clone();
        let task = tokio::spawn(async move {
            let mut event_mapper = CodexNotificationEventMapper::default();
            let mut cache_mapper = CodexNotificationCacheMapper::default();
            while let Some(message) = rx.recv().await {
                cache_mapper.map(&store, &local_task_id, &request, &message);
                event_mapper.map(&event_tx, &device_id, &local_task_id, &request, message);
            }
        });
        (Some(tx), task)
    }

    async fn collect_links(&self, archived: bool) -> Vec<RuntimeTaskLink> {
        let mut links = Vec::new();
        let mut discovered_thread_ids = HashSet::new();
        let mut discovered_local_task_ids = HashSet::new();
        let mut discovered_codex_task_signatures = HashSet::new();

        for thread in self.codex_threads(archived).await {
            if let Some(mut link) = self.link_from_thread(&thread) {
                if archived {
                    link.status = "archived".to_owned();
                    link.running = false;
                } else if link.status == "archived" {
                    continue;
                }
                link.list_order = Some(links.len());
                if let Some(thread_id) = &link.thread_id {
                    discovered_thread_ids.insert(thread_id.clone());
                }
                discovered_local_task_ids.insert(link.local_task_id.clone());
                if let Some(signature) = codex_task_signature(&link) {
                    discovered_codex_task_signatures.insert(signature);
                }
                links.push(link);
            }
        }

        for mut link in self.local_task_links(true) {
            let link_archived = link.status == "archived";
            if link_archived != archived {
                continue;
            }
            if is_cached_codex_link_hidden(&link) {
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
            if is_unmapped_pending_codex_shadow(&link, &discovered_codex_task_signatures) {
                continue;
            }
            if !self.is_active_local_task(&link.local_task_id) {
                normalize_unmapped_pending_codex_task(&mut link);
            }
            link.list_order = Some(links.len());
            links.push(link);
        }

        links
    }

    async fn codex_threads(&self, archived: bool) -> Vec<Value> {
        let started_at = Instant::now();
        if let Some(threads) = self.thread_list_cache.get(archived) {
            log_executor_event(
                "runtime work thread list cache hit",
                &[
                    ("elapsed_ms", elapsed_ms(started_at)),
                    ("archived", archived.to_string()),
                    ("threads", threads.len().to_string()),
                ],
            );
            return threads;
        }

        let mut threads = Vec::new();
        let mut cursor = None;
        let mut pages = 0_usize;
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
        self.thread_list_cache.set(archived, threads.clone());
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

    fn visible_links_for_projects(
        &self,
        links: Vec<RuntimeTaskLink>,
        project_index: &CodexGlobalProjectIndex,
    ) -> Vec<RuntimeTaskLink> {
        if !project_index.has_projects() {
            return links;
        }

        links
            .into_iter()
            .filter_map(|link| {
                if !is_codex_runtime(&link.runtime) {
                    return Some(link);
                }
                let group_path = workspace_group_path(&link.workspace_path);
                project_index
                    .project_for_path(&group_path)
                    .or_else(|| project_index.project_for_path(&link.workspace_path))?;
                Some(link)
            })
            .collect()
    }

    async fn task_link_from_payload(
        &self,
        payload: &Value,
        archived: bool,
    ) -> Result<RuntimeTaskLink, AppIpcError> {
        let local_task_id = runtime_task_id(payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "localTaskId is required"))?;
        if let Some(link) = self.local_task_link(&local_task_id) {
            return Ok(link);
        }

        for link in self.collect_links(archived).await {
            if link.local_task_id == local_task_id
                || link.thread_id.as_deref() == Some(local_task_id.as_str())
            {
                return Ok(link);
            }
        }

        let workspace_path = workspace_path(payload)
            .ok_or_else(|| AppIpcError::new("not_found", "runtime task was not found"))?;
        let mut link =
            RuntimeTaskLink::new_pending(local_task_id.clone(), workspace_path, local_task_id);
        link.thread_id = Some(link.local_task_id.clone());
        link.status = if archived { "archived" } else { "active" }.to_owned();
        link.running = false;
        Ok(link)
    }

    async fn thread_messages(&self, thread_id: &str) -> Vec<Value> {
        if let Some(cached) = self.transcript_cache.get(thread_id, false, false) {
            return cached.messages;
        }
        if let Some(thread) = self.cached_codex_thread_for_transcript(thread_id) {
            let transcript_thread = codex_thread_state(&thread);
            let messages = transcript_messages(&transcript_thread, &self.device_id);
            let workspace_path = string_field(&thread, "cwd").unwrap_or_default();
            self.transcript_cache.insert(
                thread_id.to_owned(),
                CachedTranscript::new(
                    workspace_path,
                    "codex".to_owned(),
                    messages.clone(),
                    messages.iter().any(runtime_message_running),
                    transcript_source_signature(&thread),
                )
                .with_rollout_turns(rollout_turns(&transcript_thread)),
            );
            return messages;
        }
        match self
            .codex_app_server
            .request(
                "thread/read",
                json!({"threadId": thread_id, "includeTurns": false}),
            )
            .await
        {
            Ok(response) => {
                let thread = response.get("thread").unwrap_or(&response);
                let transcript_thread = codex_thread_state(thread);
                let messages = transcript_messages(&transcript_thread, &self.device_id);
                let workspace_path = string_field(thread, "cwd").unwrap_or_default();
                self.transcript_cache.insert(
                    thread_id.to_owned(),
                    CachedTranscript::new(
                        workspace_path,
                        "codex".to_owned(),
                        messages.clone(),
                        messages.iter().any(runtime_message_running),
                        transcript_source_signature(thread),
                    )
                    .with_rollout_turns(rollout_turns(&transcript_thread)),
                );
                messages
            }
            Err(error) => {
                eprintln!("failed to read Codex app-server thread {thread_id}: {error}");
                Vec::new()
            }
        }
    }

    fn cached_codex_thread_for_transcript(&self, thread_id: &str) -> Option<Value> {
        self.thread_list_cache
            .find_thread(thread_id)
            .filter(thread_has_readable_rollout_path)
    }

    fn incremental_cached_transcript(
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
                    cached_messages(link),
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
        let running = running_hint || messages.iter().any(runtime_message_running);
        Some(
            CachedTranscript::new(
                workspace_path.to_owned(),
                "codex".to_owned(),
                messages,
                running,
                Some(current_signature),
            )
            .with_rollout_turns(Some(append.turns)),
        )
    }

    async fn call_codex_thread_method(&self, method: &str, params: Value) -> Result<Value, String> {
        let result = self.codex_app_server.request(method, params).await;
        if result.is_ok() {
            self.thread_list_cache.invalidate();
        }
        result
    }

    fn link_from_thread(&self, thread: &Value) -> Option<RuntimeTaskLink> {
        let thread_id = string_field(thread, "id")?;
        let local_link = self.local_task_by_thread_id(&thread_id);
        let workspace_path = string_field(thread, "cwd")
            .or_else(|| local_link.as_ref().map(|link| link.workspace_path.clone()))
            .unwrap_or_else(|| "~/.codex".to_owned());
        let codex_thread = thread_with_rollout_running_status(thread);
        let link = RuntimeTaskLink::from_thread(&codex_thread, local_link, workspace_path);
        Some(link)
    }

    fn local_task_links(&self, include_archived: bool) -> Vec<RuntimeTaskLink> {
        self.store.list_tasks(include_archived)
    }

    fn local_task_link(&self, local_task_id: &str) -> Option<RuntimeTaskLink> {
        self.store.get_task(local_task_id)
    }

    fn local_task_by_thread_id(&self, thread_id: &str) -> Option<RuntimeTaskLink> {
        self.store.find_by_thread_id(thread_id)
    }

    fn upsert_local_task(&self, link: RuntimeTaskLink) {
        self.store.upsert_task(link);
        self.thread_list_cache.invalidate();
    }

    fn mark_active_local_task(&self, local_task_id: &str) {
        self.active_local_tasks
            .lock()
            .expect("active local task set lock should not be poisoned")
            .insert(local_task_id.to_owned());
    }

    fn unmark_active_local_task(&self, local_task_id: &str) {
        self.active_local_tasks
            .lock()
            .expect("active local task set lock should not be poisoned")
            .remove(local_task_id);
    }

    fn is_active_local_task(&self, local_task_id: &str) -> bool {
        self.active_local_tasks
            .lock()
            .expect("active local task set lock should not be poisoned")
            .contains(local_task_id)
    }

    fn finish_local_task(&self, local_task_id: &str, thread_id: Option<String>, status: &str) {
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

fn is_unmapped_pending_codex_shadow(
    link: &RuntimeTaskLink,
    discovered_codex_task_signatures: &HashSet<String>,
) -> bool {
    is_unmapped_pending_codex_task(link)
        && codex_task_signature(link)
            .as_ref()
            .is_some_and(|signature| discovered_codex_task_signatures.contains(signature))
}

fn normalize_unmapped_pending_codex_task(link: &mut RuntimeTaskLink) {
    if !is_unmapped_pending_codex_task(link) {
        return;
    }
    link.status = "active".to_owned();
    link.running = false;
}

fn is_unmapped_pending_codex_task(link: &RuntimeTaskLink) -> bool {
    link.thread_id.is_none()
        && link.running
        && link.status == "running"
        && is_codex_runtime(&link.runtime)
}

fn codex_task_signature(link: &RuntimeTaskLink) -> Option<String> {
    if !is_codex_runtime(&link.runtime) {
        return None;
    }
    let title = link.title.trim().to_ascii_lowercase();
    if title.is_empty() || link.workspace_path.trim().is_empty() {
        return None;
    }
    Some(format!(
        "{}\0{}",
        workspace_group_path(&link.workspace_path),
        title
    ))
}

fn task_fields(task_id: i64, subtask_id: i64) -> Vec<(&'static str, String)> {
    vec![
        ("task_id", task_id.to_string()),
        ("subtask_id", subtask_id.to_string()),
    ]
}

struct RuntimeTranscriptLog<'a> {
    started_at: Instant,
    local_task_id: &'a str,
    thread_id: &'a str,
    source: &'a str,
    refresh: bool,
    running_hint: bool,
    limit: Option<usize>,
    before_cursor: Option<&'a str>,
    after_cursor: Option<&'a str>,
    message_count: usize,
    running: bool,
}

fn log_runtime_transcript_finished(details: RuntimeTranscriptLog<'_>) {
    log_executor_event(
        "runtime work transcript finished",
        &[
            ("elapsed_ms", elapsed_ms(details.started_at)),
            ("local_task_id", details.local_task_id.to_owned()),
            ("thread_id", details.thread_id.to_owned()),
            ("source", details.source.to_owned()),
            ("refresh", details.refresh.to_string()),
            ("running_hint", details.running_hint.to_string()),
            ("running", details.running.to_string()),
            ("limit", optional_usize(details.limit)),
            ("before_cursor", details.before_cursor.is_some().to_string()),
            ("after_cursor", details.after_cursor.is_some().to_string()),
            ("messages", details.message_count.to_string()),
        ],
    );
}

fn elapsed_ms(started_at: Instant) -> String {
    started_at.elapsed().as_millis().to_string()
}

fn optional_usize(value: Option<usize>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "none".to_owned())
}

fn codex_project_workspaces(project_index: &CodexGlobalProjectIndex) -> Vec<RuntimeWorkspaceLink> {
    let now = now_ms();
    project_index
        .projects()
        .iter()
        .map(|project| RuntimeWorkspaceLink {
            workspace_path: project.workspace_path.clone(),
            title: project.name.clone(),
            runtime: "codex".to_owned(),
            created_at: now,
            updated_at: now,
        })
        .collect()
}

#[derive(Clone, Default)]
struct CodexThreadListCache {
    state: Arc<Mutex<CodexThreadListCacheState>>,
}

#[derive(Default)]
struct CodexThreadListCacheState {
    active: Option<CachedCodexThreadList>,
    archived: Option<CachedCodexThreadList>,
}

#[derive(Clone)]
struct CachedCodexThreadList {
    loaded_at: i64,
    threads: Vec<Value>,
}

impl CodexThreadListCache {
    fn get(&self, archived: bool) -> Option<Vec<Value>> {
        let state = self.state.lock().ok()?;
        let cached = if archived {
            state.archived.as_ref()
        } else {
            state.active.as_ref()
        }?;
        if now_ms().saturating_sub(cached.loaded_at) > CODEX_THREAD_LIST_CACHE_TTL_MS {
            return None;
        }
        Some(cached.threads.clone())
    }

    fn set(&self, archived: bool, threads: Vec<Value>) {
        if let Ok(mut state) = self.state.lock() {
            let cached = Some(CachedCodexThreadList {
                loaded_at: now_ms(),
                threads,
            });
            if archived {
                state.archived = cached;
            } else {
                state.active = cached;
            }
        }
    }

    fn find_thread(&self, thread_id: &str) -> Option<Value> {
        let state = self.state.lock().ok()?;
        state
            .active
            .as_ref()
            .into_iter()
            .chain(state.archived.as_ref())
            .flat_map(|cached| cached.threads.iter())
            .find(|thread| string_field(thread, "id").as_deref() == Some(thread_id))
            .cloned()
    }

    fn invalidate(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.active = None;
            state.archived = None;
        }
    }
}

fn codex_thread_list_params(archived: bool, cursor: Option<&str>) -> Value {
    let mut params = json!({
        "limit": CODEX_THREAD_LIST_PAGE_SIZE,
        "sortKey": "recency_at",
        "sortDirection": "desc",
        "sourceKinds": CODEX_THREAD_SOURCE_KINDS,
        "archived": archived,
        "useStateDbOnly": true,
    });
    if let Some(cursor) = cursor {
        params["cursor"] = Value::String(cursor.to_owned());
    }
    params
}

fn thread_has_readable_rollout_path(thread: &Value) -> bool {
    string_field(thread, "path")
        .map(|path| Path::new(&path).is_file())
        .unwrap_or(false)
}

fn payload_runtime_is_codex(payload: &Value) -> bool {
    string_field(payload, "runtime")
        .map(|runtime| is_codex_runtime(&runtime))
        .unwrap_or(true)
}

fn is_cached_codex_link_hidden(link: &RuntimeTaskLink) -> bool {
    is_codex_runtime(&link.runtime)
        && !link.running
        && link.thread_id.is_some()
        && link.status != "archived"
}

fn is_codex_runtime(runtime: &str) -> bool {
    runtime.eq_ignore_ascii_case("codex")
}

fn append_unique_links(links: &mut Vec<RuntimeTaskLink>, new_links: Vec<RuntimeTaskLink>) {
    let mut keys = links.iter().map(link_key).collect::<HashSet<_>>();
    for link in new_links {
        if keys.insert(link_key(&link)) {
            links.push(link);
        }
    }
}

fn link_key(link: &RuntimeTaskLink) -> String {
    link.thread_id
        .clone()
        .unwrap_or_else(|| link.local_task_id.clone())
}

fn text_match(text: &str, query: &str) -> Option<(usize, usize)> {
    let normalized_query = query.trim().to_ascii_lowercase();
    if normalized_query.is_empty() {
        return None;
    }
    let normalized_text = text.to_ascii_lowercase();
    normalized_text
        .find(&normalized_query)
        .map(|start| (start, start + normalized_query.len()))
}

fn first_message_search_result(
    link: &RuntimeTaskLink,
    device_id: &str,
    messages: Vec<Value>,
    query: &str,
) -> Option<Value> {
    for message in messages {
        let content = string_field(&message, "content").unwrap_or_default();
        let Some((match_start, match_end)) = text_match(&content, query) else {
            continue;
        };
        return Some(search_result_item(
            link,
            device_id,
            SearchResultMatch {
                snippet: content,
                match_start,
                match_end,
                message_id: string_field(&message, "id").unwrap_or_default(),
                message_role: string_field(&message, "role")
                    .unwrap_or_else(|| "message".to_owned()),
                message_created_at: message.get("createdAt").cloned().unwrap_or(Value::Null),
            },
        ));
    }
    None
}

fn cached_transcript_response(
    link: &RuntimeTaskLink,
    messages: Vec<Value>,
    limit: Option<usize>,
    before_cursor: Option<&str>,
    after_cursor: Option<&str>,
) -> Value {
    transcript_response(
        &link.local_task_id,
        link.workspace_path.clone(),
        link.runtime.clone(),
        messages,
        limit,
        before_cursor,
        after_cursor,
    )
}

fn transcript_response(
    local_task_id: &str,
    workspace_path: String,
    runtime: String,
    messages: Vec<Value>,
    limit: Option<usize>,
    before_cursor: Option<&str>,
    after_cursor: Option<&str>,
) -> Value {
    let turn_navigation = transcript_turn_navigation(&messages);
    let page = transcript_page(messages, limit, before_cursor, after_cursor);
    json!({
        "success": true,
        "localTaskId": local_task_id,
        "workspacePath": workspace_path,
        "runtime": runtime,
        "messages": page.messages,
        "turnNavigation": turn_navigation,
        "rangeStart": page.range_start,
        "rangeEnd": page.range_end,
        "hasMoreBefore": page.has_more_before,
        "beforeCursor": page
            .before_cursor
            .map(Value::String)
            .unwrap_or(Value::Null),
        "hasMoreAfter": page.has_more_after,
        "afterCursor": page
            .after_cursor
            .map(Value::String)
            .unwrap_or(Value::Null),
    })
}

fn transcript_turn_navigation(messages: &[Value]) -> Vec<Value> {
    let mut turns: Vec<Value> = Vec::new();
    let mut pending_response_turn_indexes: Vec<usize> = Vec::new();

    for (message_index, message) in messages.iter().enumerate() {
        let role = string_field(message, "role").unwrap_or_default();
        if !role.eq_ignore_ascii_case("user") {
            if role.eq_ignore_ascii_case("assistant") && !pending_response_turn_indexes.is_empty() {
                let response_preview = transcript_message_preview(message);
                for turn_index in pending_response_turn_indexes.drain(..) {
                    if let Some(turn) = turns.get_mut(turn_index).and_then(Value::as_object_mut) {
                        turn.insert(
                            "responsePreview".to_owned(),
                            Value::String(response_preview.clone()),
                        );
                    }
                }
            }
            continue;
        }

        turns.push(json!({
            "id": string_field(message, "id").unwrap_or_else(|| format!("message-{message_index}")),
            "turnIndex": turns.len(),
            "messageIndex": message_index,
            "cursor": format!("offset:{message_index}"),
            "promptPreview": transcript_message_preview(message),
            "responsePreview": "",
        }));
        pending_response_turn_indexes.push(turns.len() - 1);
    }

    turns
}

fn transcript_message_preview(message: &Value) -> String {
    truncate_navigation_preview(&string_field(message, "content").unwrap_or_default())
}

fn truncate_navigation_preview(content: &str) -> String {
    let normalized = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut preview = String::new();
    for (index, ch) in normalized.chars().enumerate() {
        if index >= TRANSCRIPT_NAVIGATION_PREVIEW_CHARS {
            preview.push('…');
            return preview;
        }
        preview.push(ch);
    }
    preview
}

fn transcript_limit(payload: &Value) -> Option<usize> {
    integer_field(payload, "limit")
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
}

fn append_changed_transcript_messages(
    cached_messages: Vec<Value>,
    thread: &Value,
    turns: &[Value],
    changed_start: Option<usize>,
    device_id: &str,
) -> Vec<Value> {
    let Some(changed_start) = changed_start else {
        return cached_messages;
    };
    let Some(changed_turn_id) = turns
        .get(changed_start)
        .and_then(|turn| string_field(turn, "id"))
    else {
        return transcript_messages(&thread_with_turns(thread, turns.to_vec()), device_id);
    };

    let mut messages = cached_messages
        .into_iter()
        .take_while(|message| string_field(message, "turnId").as_deref() != Some(&changed_turn_id))
        .collect::<Vec<_>>();
    let changed_thread = thread_with_turns(thread, turns[changed_start..].to_vec());
    messages.extend(transcript_messages(&changed_thread, device_id));
    messages
}

fn runtime_message_running(message: &Value) -> bool {
    string_field(message, "status")
        .map(|status| {
            matches!(
                status.replace(['_', '-'], "").to_ascii_lowercase().as_str(),
                "streaming" | "running" | "inprogress" | "active" | "busy" | "pending"
            )
        })
        .unwrap_or(false)
}

fn transcript_source_signature(thread: &Value) -> Option<TranscriptSourceSignature> {
    string_field(thread, "path").and_then(|path| TranscriptSourceSignature::from_path(&path))
}

fn codex_thread_state(thread: &Value) -> Value {
    thread_with_rollout_turns(thread).unwrap_or_else(|| thread.clone())
}

fn cached_user_message(
    local_task_id: &str,
    request: &ExecutionRequest,
    payload: &Value,
) -> Option<Value> {
    let content = payload
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| payload.get("content").and_then(Value::as_str))
        .filter(|content| !content.trim().is_empty())?;

    let mut message = Map::new();
    message.insert(
        "id".to_owned(),
        Value::String(format!(
            "{local_task_id}:user:{}",
            if request.subtask_id > 0 {
                request.subtask_id
            } else {
                now_ms()
            }
        )),
    );
    message.insert("role".to_owned(), Value::String("user".to_owned()));
    message.insert("content".to_owned(), Value::String(content.to_owned()));
    message.insert("status".to_owned(), Value::String("done".to_owned()));
    message.insert("createdAt".to_owned(), Value::Number(now_ms().into()));
    if let Some(source) = payload
        .get("source")
        .filter(|value| value.is_object())
        .cloned()
    {
        message.insert("source".to_owned(), source);
    }
    let attachments = normalized_attachments(payload.get("attachments"));
    if !attachments.is_empty() {
        message.insert("attachments".to_owned(), Value::Array(attachments));
    }
    Some(Value::Object(message))
}

fn normalized_attachments(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|attachment| {
            let object = attachment.as_object()?;
            let mut normalized = Map::new();
            if let Some(id) = object.get("id").cloned() {
                normalized.insert("id".to_owned(), id);
            }
            let filename = object
                .get("filename")
                .or_else(|| object.get("original_filename"))
                .and_then(Value::as_str)
                .unwrap_or("attachment")
                .to_owned();
            normalized.insert("filename".to_owned(), Value::String(filename));
            copy_attachment_field(object, &mut normalized, "file_size");
            copy_attachment_field(object, &mut normalized, "mime_type");
            copy_attachment_field(object, &mut normalized, "subtask_id");
            copy_attachment_field(object, &mut normalized, "file_extension");
            copy_attachment_field_alias(
                object,
                &mut normalized,
                "local_path",
                &["local_path", "localPath"],
            );
            copy_attachment_field_alias(
                object,
                &mut normalized,
                "local_preview_url",
                &["local_preview_url", "localPreviewUrl"],
            );
            if !normalized.contains_key("local_preview_url") {
                if let Some(local_path) = normalized.get("local_path").cloned() {
                    normalized.insert("local_preview_url".to_owned(), local_path);
                }
            }
            normalized.insert("status".to_owned(), Value::String("ready".to_owned()));
            normalized.insert("created_at".to_owned(), Value::Number(now_ms().into()));
            Some(Value::Object(normalized))
        })
        .collect()
}

fn copy_attachment_field(source: &Map<String, Value>, target: &mut Map<String, Value>, key: &str) {
    if let Some(value) = source.get(key).cloned() {
        target.insert(key.to_owned(), value);
    }
}

fn copy_attachment_field_alias(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    target_key: &str,
    source_keys: &[&str],
) {
    for source_key in source_keys {
        if let Some(value) = source.get(*source_key).cloned() {
            target.insert(target_key.to_owned(), value);
            return;
        }
    }
}

fn runtime_handle_json(link: &RuntimeTaskLink) -> Value {
    let mut object = link
        .runtime_handle
        .as_object()
        .cloned()
        .unwrap_or_else(Map::new);
    object.insert(
        "threadId".to_owned(),
        link.thread_id
            .as_ref()
            .map(|thread_id| Value::String(thread_id.clone()))
            .unwrap_or(Value::Null),
    );
    Value::Object(object)
}

fn runtime_session_id_from_link(link: &RuntimeTaskLink) -> Option<String> {
    link.thread_id
        .clone()
        .or_else(|| runtime_session_id_from_handle(&link.runtime_handle))
}

fn runtime_session_id_from_payload(payload: &Value) -> Option<String> {
    let address = payload.get("address");
    payload
        .get("runtimeHandle")
        .or_else(|| payload.get("runtime_handle"))
        .and_then(runtime_session_id_from_handle)
        .or_else(|| {
            address.and_then(|address| {
                address
                    .get("runtimeHandle")
                    .or_else(|| address.get("runtime_handle"))
                    .and_then(runtime_session_id_from_handle)
            })
        })
        .or_else(|| string_field(payload, "providerSessionId"))
        .or_else(|| string_field(payload, "provider_session_id"))
        .or_else(|| address.and_then(|address| string_field(address, "providerSessionId")))
        .or_else(|| address.and_then(|address| string_field(address, "provider_session_id")))
}

fn runtime_session_id_from_handle(handle: &Value) -> Option<String> {
    string_field(handle, "sessionId")
        .or_else(|| string_field(handle, "session_id"))
        .or_else(|| string_field(handle, "threadId"))
        .or_else(|| string_field(handle, "thread_id"))
        .or_else(|| string_field(handle, "conversationId"))
        .or_else(|| string_field(handle, "conversation_id"))
}

fn runtime_has_provider_transcript_reader(runtime: &str) -> bool {
    runtime.trim().eq_ignore_ascii_case("codex")
}

fn source_parent_json(source: &super::fork_transfer::SourceTaskIdentity) -> Value {
    let mut parent = Map::new();
    if let Some(device_id) = &source.device_id {
        parent.insert("deviceId".to_owned(), Value::String(device_id.clone()));
    }
    if let Some(workspace_path) = &source.workspace_path {
        parent.insert(
            "workspacePath".to_owned(),
            Value::String(workspace_path.clone()),
        );
    }
    parent.insert(
        "localTaskId".to_owned(),
        Value::String(source.local_task_id.clone()),
    );
    if let Some(thread_id) = &source.thread_id {
        parent.insert("threadId".to_owned(), Value::String(thread_id.clone()));
    }
    if let Some(runtime) = &source.runtime {
        parent.insert("runtime".to_owned(), Value::String(runtime.clone()));
    }
    Value::Object(parent)
}

fn fork_error_response(code: &str, error: String) -> Value {
    json!({
        "success": false,
        "error": error,
        "code": code,
    })
}

fn task_action_success(link: &RuntimeTaskLink) -> Value {
    json!({
        "success": true,
        "accepted": true,
        "localTaskId": link.local_task_id,
        "workspacePath": link.workspace_path,
        "runtime": link.runtime,
    })
}

fn task_action_failure(link: &RuntimeTaskLink, error: String) -> Value {
    json!({
        "success": false,
        "accepted": false,
        "localTaskId": link.local_task_id,
        "workspacePath": link.workspace_path,
        "runtime": link.runtime,
        "error": error,
    })
}

impl RuntimeWorkHandler for RuntimeWorkRpcHandler {
    fn handle_runtime_rpc<'a>(
        &'a self,
        data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            let method = string_field(&data, "method")
                .ok_or_else(|| AppIpcError::new("bad_request", "method is required"))?;
            let payload = data
                .get("payload")
                .cloned()
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({}));
            self.dispatch(&method, payload).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_user_message_uses_explicit_payload_text() {
        let request = ExecutionRequest {
            subtask_id: 42,
            prompt: json!([
                {"type": "input_text", "text": "# AGENTS.md instructions\n\n<environment_context>"},
                {"type": "input_text", "text": "visible user text"}
            ]),
            ..ExecutionRequest::default()
        };

        let message = cached_user_message(
            "local-task",
            &request,
            &json!({"message": "visible user text"}),
        )
        .expect("payload message should create a cached user message");

        assert_eq!(message["content"], "visible user text");

        let content_message = cached_user_message(
            "local-task",
            &request,
            &json!({"content": "visible content text"}),
        )
        .expect("payload content should create a cached user message");

        assert_eq!(content_message["content"], "visible content text");
    }

    #[test]
    fn cached_user_message_does_not_fallback_to_prompt() {
        let request = ExecutionRequest {
            subtask_id: 42,
            prompt: json!([
                {"type": "input_text", "text": "# AGENTS.md instructions\n\n<environment_context>"}
            ]),
            ..ExecutionRequest::default()
        };

        assert!(cached_user_message("local-task", &request, &json!({})).is_none());
    }

    #[test]
    fn cached_message_merge_preserves_codex_rebuilt_blocks() {
        let codex_messages = vec![json!({
            "id": "assistant-turn-1",
            "role": "assistant",
            "content": "done",
            "status": "cancelled",
            "blocks": [
                {
                    "id": "tool-1",
                    "type": "tool",
                    "tool_name": "exec_command",
                    "status": "done"
                }
            ],
            "stoppedNotice": true
        })];
        let cached_messages = vec![json!({
            "id": "cached-assistant",
            "role": "assistant",
            "content": "done",
            "status": "done",
            "source": {"source": "im"},
            "blocks": [
                {
                    "id": "thinking-1",
                    "type": "thinking",
                    "content": "inspect",
                    "status": "done"
                },
                {
                    "id": "tool-1",
                    "type": "tool",
                    "tool_name": "stale_tool",
                    "status": "pending"
                }
            ]
        })];

        let merged = merge_cached_messages(codex_messages, cached_messages);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["status"], "cancelled");
        assert_eq!(merged[0]["stoppedNotice"], true);
        assert_eq!(merged[0]["blocks"][0]["type"], "thinking");
        assert_eq!(merged[0]["blocks"][1]["tool_name"], "exec_command");
        assert_eq!(merged[0]["blocks"][1]["status"], "done");
        assert_eq!(merged[0]["source"]["source"], "im");
    }

    #[test]
    fn cached_message_merge_matches_assistant_by_subtask_id() {
        let codex_messages = vec![json!({
            "id": "assistant-server",
            "role": "assistant",
            "content": "server snapshot",
            "subtaskId": 42,
        })];
        let cached_messages = vec![json!({
            "id": "assistant-live",
            "role": "assistant",
            "content": "live delta",
            "subtaskId": 42,
            "source": {"source": "im"},
        })];

        let merged = merge_cached_messages(codex_messages, cached_messages);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["id"], "assistant-server");
        assert_eq!(merged[0]["content"], "server snapshot");
        assert_eq!(merged[0]["source"]["source"], "im");
    }

    #[test]
    fn cached_message_merge_preserves_live_block_fields() {
        let codex_messages = vec![json!({
            "id": "assistant-turn-1",
            "role": "assistant",
            "content": "",
            "subtaskId": 42,
            "blocks": [
                {
                    "id": "tool-1",
                    "type": "tool",
                    "tool_name": "exec_command",
                    "status": "pending"
                }
            ],
        })];
        let cached_messages = vec![json!({
            "id": "assistant-live",
            "role": "assistant",
            "content": "",
            "subtaskId": 42,
            "blocks": [
                {
                    "id": "tool-1",
                    "type": "tool",
                    "tool_name": "exec_command",
                    "status": "done",
                    "tool_output": "ok"
                }
            ],
        })];

        let merged = merge_cached_messages(codex_messages, cached_messages);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["blocks"][0]["status"], "done");
        assert_eq!(merged[0]["blocks"][0]["tool_output"], "ok");
    }

    #[tokio::test]
    async fn cached_transcript_response_uses_requested_local_task_id() {
        let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
        let mut link = RuntimeTaskLink::new_pending(
            "local-task-1".to_owned(),
            "/tmp/project".to_owned(),
            "Mapped task".to_owned(),
        );
        link.thread_id = Some("thread-1".to_owned());
        link.running = false;
        link.status = "active".to_owned();
        handler.upsert_local_task(link);
        handler.transcript_cache.insert(
            "thread-1",
            CachedTranscript::new(
                "/tmp/project".to_owned(),
                "codex".to_owned(),
                vec![json!({"id":"assistant-1","role":"assistant","content":"cached"})],
                false,
                None,
            ),
        );

        let result = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.tasks.transcript",
                "payload": {"localTaskId": "local-task-1"}
            }))
            .await
            .expect("cached transcript should return");

        assert_eq!(result["localTaskId"], "local-task-1");
        assert_eq!(result["messages"][0]["content"], "cached");
    }

    #[tokio::test]
    async fn transcript_without_runtime_link_returns_empty_local_transcript() {
        let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

        let result = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.tasks.transcript",
                "payload": {
                    "localTaskId": "optimistic-local-task",
                    "workspacePath": "/tmp/project"
                }
            }))
            .await
            .expect("missing runtime link should not read provider session");

        assert_eq!(result["success"], true);
        assert_eq!(result["localTaskId"], "optimistic-local-task");
        assert_eq!(result["workspacePath"], "/tmp/project");
        assert_eq!(result["messages"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn transcript_uses_explicit_runtime_handle_session_without_rewriting_local_task_id() {
        let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
        handler.transcript_cache.insert(
            "provider-session-1",
            CachedTranscript::new(
                "/tmp/project".to_owned(),
                "codex".to_owned(),
                vec![json!({"id":"assistant-1","role":"assistant","content":"cached"})],
                false,
                None,
            ),
        );

        let result = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.tasks.transcript",
                "payload": {
                    "localTaskId": "local-visible-task",
                    "workspacePath": "/tmp/project",
                    "runtimeHandle": {
                        "threadId": "provider-session-1"
                    }
                }
            }))
            .await
            .expect("explicit runtime handle should read cached provider session");

        assert_eq!(result["localTaskId"], "local-visible-task");
        assert_eq!(result["messages"][0]["content"], "cached");
    }

    #[test]
    fn changed_transcript_messages_replace_tail_from_changed_turn() {
        let cached_messages = vec![
            json!({
                "id": "user-1",
                "role": "user",
                "content": "old",
                "turnId": "turn-1",
            }),
            json!({
                "id": "assistant-turn-2",
                "role": "assistant",
                "content": "stale",
                "turnId": "turn-2",
            }),
        ];
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/workspace",
        });
        let turns = vec![
            json!({
                "id": "turn-1",
                "createdAt": 1,
                "status": "completed",
                "items": [],
            }),
            json!({
                "id": "turn-2",
                "createdAt": 2,
                "status": "completed",
                "items": [
                    {"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"fresh"}]}}
                ],
            }),
        ];

        let messages =
            append_changed_transcript_messages(cached_messages, &thread, &turns, Some(1), "device");

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["id"], "user-1");
        assert_eq!(messages[1]["id"], "assistant-turn-2");
        assert_eq!(messages[1]["content"], "fresh");
        assert_eq!(messages[1]["turnId"], "turn-2");
    }

    #[test]
    fn incremental_transcript_rejects_changed_rollout_path() {
        let old_path = std::env::temp_dir().join(format!(
            "wegent-old-rollout-{}-{}.jsonl",
            std::process::id(),
            now_ms()
        ));
        let new_path = std::env::temp_dir().join(format!(
            "wegent-new-rollout-{}-{}.jsonl",
            std::process::id(),
            now_ms()
        ));
        std::fs::write(&old_path, "{}\n").unwrap();
        std::fs::write(&new_path, "{}\n").unwrap();
        let cached = CachedTranscript::new(
            "/tmp/project".to_owned(),
            "codex".to_owned(),
            Vec::new(),
            false,
            TranscriptSourceSignature::from_path(&old_path.display().to_string()),
        )
        .with_rollout_turns(Some(vec![json!({
            "id": "turn-1",
            "status": "completed",
            "items": [],
        })]));
        let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
        let thread = json!({
            "id": "thread-1",
            "path": new_path.display().to_string(),
            "cwd": "/tmp/project",
        });

        let result =
            handler.incremental_cached_transcript(cached, &thread, None, false, "/tmp/project");

        assert!(result.is_none());
        let _ = std::fs::remove_file(old_path);
        let _ = std::fs::remove_file(new_path);
    }
}
