// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashSet, future::Future, pin::Pin};

use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

use crate::{
    agents::{request_codex_app_server, run_codex_app_server_turn, CodexNotificationSender},
    local::app_ipc::{AppIpcError, RuntimeWorkHandler},
    protocol::ExecutionRequest,
    runner::ExecutionOutcome,
};

use super::{
    events::{emit_response_event, map_codex_notification},
    response::{
        archived_conversations_response, search_result_item, thread_list_params,
        workspace_response, RuntimeTaskLink, SearchResultMatch,
    },
    store::RuntimeWorkStore,
    transcript::transcript_messages,
    util::{
        bool_field, execution_request, execution_request_from_payload, integer_field,
        normalize_device_id, now_ms, runtime_task_id, string_field,
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
            "runtime.tasks.archive" => self.archive_task(payload).await,
            "runtime.tasks.rename" => self.rename_task(payload).await,
            "runtime.tasks.cancel" => Ok(json!({"success": true, "accepted": false})),
            "runtime.archived_conversations.list" => {
                self.list_archived_conversations(payload).await
            }
            "runtime.archived_conversations.unarchive" => self.unarchive_task(payload).await,
            "runtime.archived_conversations.delete" => self.delete_archived_task(payload).await,
            "runtime.archived_conversations.delete_bulk" => {
                self.delete_archived_tasks_bulk(payload).await
            }
            "runtime.workspaces.open" => self.open_workspace(payload).await,
            unsupported => Err(AppIpcError::new(
                "unsupported_method",
                format!("Unsupported runtime RPC method: {unsupported}"),
            )),
        }
    }

    async fn list_tasks(&self) -> Result<Value, AppIpcError> {
        let links = self.collect_links(false).await;
        Ok(json!({
            "success": true,
            "workspaces": workspace_response(links),
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

        Ok(json!({
            "success": true,
            "localTaskId": local_task_id,
            "workspacePath": workspace_path,
            "runtime": "codex",
            "messages": transcript_messages(thread),
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
        let workspace_path = string_field(&payload, "workspacePath")
            .or_else(|| string_field(&payload, "workspace_path"))
            .or_else(|| {
                execution_request(&payload).and_then(|request| request.cwd().map(str::to_owned))
            })
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let title = string_field(&payload, "title")
            .or_else(|| string_field(&payload, "message"))
            .unwrap_or_else(|| local_task_id.clone());
        let request = execution_request(&payload)
            .unwrap_or_else(|| execution_request_from_payload(&payload, &workspace_path));

        self.upsert_local_task(RuntimeTaskLink::new_pending(
            local_task_id.clone(),
            workspace_path,
            title,
        ));
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
        let thread_id = self.thread_id_for_local_task(&local_task_id);
        let workspace_path = string_field(&payload, "workspacePath")
            .or_else(|| string_field(&payload, "workspace_path"))
            .or_else(|| {
                self.local_task_link(&local_task_id)
                    .map(|link| link.workspace_path)
            })
            .unwrap_or_default();
        let mut request = execution_request(&payload)
            .unwrap_or_else(|| execution_request_from_payload(&payload, &workspace_path));
        if request.project_workspace_path.is_none() && !workspace_path.is_empty() {
            request.project_workspace_path = Some(workspace_path);
        }

        self.spawn_turn(local_task_id.clone(), request, Some(thread_id));

        Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": self.device_id,
            "localTaskId": local_task_id,
            "runtime": "codex",
        }))
    }

    async fn open_workspace(&self, payload: Value) -> Result<Value, AppIpcError> {
        let workspace_path = string_field(&payload, "workspacePath")
            .or_else(|| string_field(&payload, "workspace_path"))
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let response = request_codex_app_server(
            &self.codex_binary,
            "thread/start",
            json!({"cwd": workspace_path, "approvalPolicy": "never"}),
        )
        .await
        .map_err(|error| AppIpcError::new("codex_error", error))?;
        let thread_id = response
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| AppIpcError::new("codex_error", "thread/start returned no thread.id"))?;

        Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": self.device_id,
            "localTaskId": thread_id,
            "workspacePath": workspace_path,
            "runtime": "codex",
        }))
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

        let workspace_path = string_field(payload, "workspacePath")
            .or_else(|| string_field(payload, "workspace_path"))
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
                transcript_messages(thread)
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
