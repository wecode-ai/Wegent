// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashSet, future::Future, pin::Pin};

use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, mpsc};

use crate::{
    agents::{request_codex_app_server, run_codex_app_server_turn, CodexNotificationSender},
    local::app_ipc::{AppIpcError, RuntimeWorkHandler},
    protocol::ExecutionRequest,
    runner::ExecutionOutcome,
};

use super::{
    codex_global_state::{
        ensure_codex_global_project, remove_codex_global_project, rename_codex_global_project,
        CodexGlobalProjectIndex,
    },
    events::{emit_response_event, map_codex_notification},
    response::{
        archived_conversations_response, search_result_item, thread_list_params,
        workspace_response, RuntimeTaskLink, RuntimeWorkspaceLink, SearchResultMatch,
    },
    store::RuntimeWorkStore,
    transcript::transcript_messages,
    util::{
        apply_runtime_payload_metadata, bool_field, execution_request,
        execution_request_from_payload, integer_field, normalize_device_id, now_ms, prompt_text,
        runtime_task_id, string_field, workspace_group_path, workspace_path,
    },
};

#[derive(Clone)]
pub struct RuntimeWorkRpcHandler {
    device_id: String,
    codex_binary: String,
    event_tx: Option<broadcast::Sender<Value>>,
    store: RuntimeWorkStore,
}

impl RuntimeWorkRpcHandler {
    pub fn new(device_id: impl Into<String>, codex_binary: impl Into<String>) -> Self {
        Self {
            device_id: normalize_device_id(device_id.into()),
            codex_binary: codex_binary.into(),
            event_tx: None,
            store: RuntimeWorkStore::from_env(),
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
        let project_index = CodexGlobalProjectIndex::load();
        let links =
            self.visible_links_for_projects(self.collect_links(false).await, &project_index);
        Ok(json!({
            "success": true,
            "workspaces": workspace_response(links, codex_project_workspaces(&project_index)),
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
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "localTaskId is required"))?;
        let local_link = self.local_task_link(&local_task_id);
        if local_link
            .as_ref()
            .is_some_and(|link| link.runtime != "codex" || link.thread_id.is_none())
        {
            let link = local_link.expect("local link was checked");
            return Ok(cached_transcript_response(&link, cached_messages(&link)));
        }
        let thread_id = self.thread_id_for_local_task(&local_task_id);

        let response = request_codex_app_server(
            &self.codex_binary,
            "thread/read",
            json!({"threadId": thread_id, "includeTurns": true}),
        )
        .await
        .map_err(|error| AppIpcError::new("codex_error", error))?;
        let thread = response.get("thread").unwrap_or(&response);
        let workspace_path = string_field(thread, "cwd")
            .or_else(|| string_field(&payload, "workspacePath"))
            .or_else(|| string_field(&payload, "workspace_path"))
            .unwrap_or_default();
        let messages = local_link
            .as_ref()
            .map(|link| {
                merge_cached_messages(
                    transcript_messages(thread, &self.device_id),
                    cached_messages(link),
                )
            })
            .unwrap_or_else(|| transcript_messages(thread, &self.device_id));

        Ok(json!({
            "success": true,
            "localTaskId": local_task_id,
            "workspacePath": workspace_path,
            "runtime": "codex",
            "messages": messages,
            "hasMoreBefore": false,
            "beforeCursor": Value::Null,
        }))
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
        let mut request = execution_request(&payload)
            .unwrap_or_else(|| execution_request_from_payload(&payload, &workspace_path));
        apply_runtime_payload_metadata(&mut request, &payload);

        let mut link =
            RuntimeTaskLink::new_pending(local_task_id.clone(), workspace_path.clone(), title);
        if let Some(message) = cached_user_message(&local_task_id, &request, &payload) {
            set_runtime_handle_messages(&mut link.runtime_handle, vec![message]);
        }
        self.upsert_local_task(link);
        self.spawn_turn(local_task_id.clone(), request, None);

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
        if self
            .local_task_link(&local_task_id)
            .is_some_and(|link| link.running)
        {
            return Ok(json!({
                "success": false,
                "error": "runtime task is already running",
                "code": "bad_request",
            }));
        }
        let thread_id = self.thread_id_for_local_task(&local_task_id);
        let workspace_path = workspace_path(&payload)
            .or_else(|| {
                self.local_task_link(&local_task_id)
                    .map(|link| link.workspace_path)
            })
            .unwrap_or_default();
        let mut request = execution_request(&payload)
            .unwrap_or_else(|| execution_request_from_payload(&payload, &workspace_path));
        apply_runtime_payload_metadata(&mut request, &payload);
        request.new_session = false;
        if request.project_workspace_path.is_none() && !workspace_path.is_empty() {
            request.project_workspace_path = Some(workspace_path.clone());
        }

        self.mark_task_running_for_send(
            &local_task_id,
            &thread_id,
            &workspace_path,
            &request,
            &payload,
        );
        self.spawn_turn(local_task_id.clone(), request, Some(thread_id));

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
    ) {
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
                notifications,
            )
            .await;
            mapper_task.abort();

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
                    ExecutionOutcome::Failed { message } => emit_response_event(
                        &self.event_tx,
                        &self.device_id,
                        "response.failed",
                        local_task_id,
                        request,
                        json!({"error": {"message": message}}),
                    ),
                    ExecutionOutcome::Running => {}
                }
            }
            Err(error) => {
                self.finish_local_task(local_task_id, None, "failed");
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
        let task = tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                map_codex_notification(&event_tx, &device_id, &local_task_id, &request, message);
            }
        });
        (Some(tx), task)
    }

    async fn collect_links(&self, archived: bool) -> Vec<RuntimeTaskLink> {
        let mut links = Vec::new();
        let mut discovered_thread_ids = HashSet::new();
        let mut discovered_local_task_ids = HashSet::new();

        match request_codex_app_server(
            &self.codex_binary,
            "thread/list",
            thread_list_params(archived),
        )
        .await
        {
            Ok(response) => {
                for thread in response
                    .get("data")
                    .or_else(|| response.get("threads"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(mut link) = self.link_from_thread(thread) {
                        if archived {
                            link.status = "archived".to_owned();
                            link.running = false;
                        } else if link.status == "archived" {
                            continue;
                        }
                        if let Some(thread_id) = &link.thread_id {
                            discovered_thread_ids.insert(thread_id.clone());
                        }
                        discovered_local_task_ids.insert(link.local_task_id.clone());
                        links.push(link);
                    }
                }
            }
            Err(error) => {
                eprintln!("failed to list Codex app-server threads: {error}");
            }
        }

        for link in self.local_task_links(true) {
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
            links.push(link);
        }

        links.sort_by_key(|link| std::cmp::Reverse(link.updated_at));
        links
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
            .filter_map(|mut link| {
                if !is_codex_runtime(&link.runtime) {
                    return Some(link);
                }
                let group_path = workspace_group_path(&link.workspace_path);
                let project = project_index
                    .project_for_path(&group_path)
                    .or_else(|| project_index.project_for_path(&link.workspace_path))?;
                link.workspace_path = project.workspace_path.clone();
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
        match request_codex_app_server(
            &self.codex_binary,
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

    async fn call_codex_thread_method(&self, method: &str, params: Value) -> Result<Value, String> {
        request_codex_app_server(&self.codex_binary, method, params).await
    }

    fn link_from_thread(&self, thread: &Value) -> Option<RuntimeTaskLink> {
        let thread_id = string_field(thread, "id")?;
        let local_link = self.local_task_by_thread_id(&thread_id);
        let workspace_path = string_field(thread, "cwd")
            .or_else(|| local_link.as_ref().map(|link| link.workspace_path.clone()))
            .unwrap_or_else(|| "~/.codex".to_owned());
        Some(RuntimeTaskLink::from_thread(
            thread,
            local_link,
            workspace_path,
        ))
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

    fn thread_id_for_local_task(&self, local_task_id: &str) -> String {
        self.local_task_link(local_task_id)
            .and_then(|link| link.thread_id)
            .unwrap_or_else(|| local_task_id.to_owned())
    }

    fn upsert_local_task(&self, link: RuntimeTaskLink) {
        self.store.upsert_task(link);
    }

    fn finish_local_task(&self, local_task_id: &str, thread_id: Option<String>, status: &str) {
        self.store.update_task(local_task_id, |link| {
            if thread_id.is_some() {
                link.thread_id = thread_id;
            }
            link.status = status.to_owned();
            link.running = status == "running";
            link.updated_at = now_ms();
        });
    }
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

fn payload_runtime_is_codex(payload: &Value) -> bool {
    string_field(payload, "runtime")
        .map(|runtime| is_codex_runtime(&runtime))
        .unwrap_or(true)
}

fn is_cached_codex_link_hidden(link: &RuntimeTaskLink) -> bool {
    is_codex_runtime(&link.runtime) && !link.running && link.thread_id.is_some()
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

fn cached_transcript_response(link: &RuntimeTaskLink, messages: Vec<Value>) -> Value {
    json!({
        "success": true,
        "localTaskId": link.local_task_id,
        "workspacePath": link.workspace_path,
        "runtime": link.runtime,
        "messages": messages,
        "hasMoreBefore": false,
        "beforeCursor": Value::Null,
    })
}

fn cached_messages(link: &RuntimeTaskLink) -> Vec<Value> {
    link.runtime_handle
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|message| message.is_object())
        .cloned()
        .collect()
}

fn merge_cached_messages(codex_messages: Vec<Value>, cached_messages: Vec<Value>) -> Vec<Value> {
    if cached_messages.is_empty() {
        return codex_messages;
    }
    if codex_messages.is_empty() {
        return cached_messages;
    }

    let mut used = vec![false; cached_messages.len()];
    let mut merged = codex_messages
        .into_iter()
        .map(|codex_message| {
            let Some(index) =
                cached_messages
                    .iter()
                    .enumerate()
                    .find_map(|(index, cached_message)| {
                        if !used[index] && messages_match(&codex_message, cached_message) {
                            Some(index)
                        } else {
                            None
                        }
                    })
            else {
                return codex_message;
            };
            used[index] = true;
            cached_messages[index].clone()
        })
        .collect::<Vec<_>>();

    for (index, cached_message) in cached_messages.into_iter().enumerate() {
        if !used[index] {
            merged.push(cached_message);
        }
    }
    merged
}

fn messages_match(left: &Value, right: &Value) -> bool {
    if string_field(left, "role") != string_field(right, "role") {
        return false;
    }
    let left_content = string_field(left, "content").unwrap_or_default();
    let right_content = string_field(right, "content").unwrap_or_default();
    if left_content == right_content {
        return true;
    }
    !right_content.is_empty()
        && right.get("attachments").is_some()
        && left_content.contains(&right_content)
}

fn cached_user_message(
    local_task_id: &str,
    request: &ExecutionRequest,
    payload: &Value,
) -> Option<Value> {
    let content = prompt_text(&request.prompt);
    if content.trim().is_empty() {
        return None;
    }

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
    message.insert("content".to_owned(), Value::String(content));
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

fn set_runtime_handle_messages(runtime_handle: &mut Value, messages: Vec<Value>) {
    let mut object = runtime_handle.as_object().cloned().unwrap_or_default();
    object.insert("messages".to_owned(), Value::Array(messages));
    *runtime_handle = Value::Object(object);
}

fn append_runtime_handle_message(runtime_handle: &mut Value, message: Value) {
    let mut messages = runtime_handle
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    messages.push(message);
    set_runtime_handle_messages(runtime_handle, messages);
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
