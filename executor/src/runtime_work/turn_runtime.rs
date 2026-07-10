// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::handler_helpers::*;
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn prepare_fork_transfer(&self, payload: Value) -> Result<Value, AppIpcError> {
        let transfer =
            match super::super::fork_transfer::validate_prepare_transfer_payload(&payload) {
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
            "taskId": link.local_task_id,
            "package": {
                "sourceRuntime": link.runtime,
                "title": link.title,
                "runtimeHandle": runtime_handle_json(&link),
                "recentMessages": cached_messages(&link),
                "archive": Value::Object(archive),
            }
        }))
    }

    pub(super) async fn import_fork(&self, payload: Value) -> Result<Value, AppIpcError> {
        let import = match super::super::fork_transfer::validate_import_fork_payload(&payload) {
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
        let runtime_handle = match super::super::fork_transfer::build_imported_runtime_handle(
            &import.fork_package,
        ) {
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

    pub(super) fn spawn_turn(&self, turn: SpawnTurnRequest) {
        let SpawnTurnRequest {
            local_task_id,
            request,
            direct_thread_id,
            fork_thread_id,
            fork_thread_path,
            resume_thread_id,
            initial_thread_name,
            initial_thread_goal,
        } = turn;
        let mut fields = task_fields(&request.task_id, &request.subtask_id);
        fields.push(("local_task_id", local_task_id.clone()));
        fields.push(("direct", direct_thread_id.is_some().to_string()));
        fields.push(("fork", fork_thread_id.is_some().to_string()));
        fields.push(("resume", resume_thread_id.is_some().to_string()));
        if let Some(thread_id) = &direct_thread_id {
            fields.push(("direct_thread_id", thread_id.clone()));
        }
        if let Some(thread_id) = &fork_thread_id {
            fields.push(("fork_thread_id", thread_id.clone()));
        }
        if let Some(path) = &fork_thread_path {
            fields.push(("fork_thread_path", path.clone()));
        }
        if let Some(thread_id) = &resume_thread_id {
            fields.push(("thread_id", thread_id.clone()));
        }
        if let Some(cwd) = request.cwd() {
            fields.push(("cwd", cwd.to_owned()));
        }
        log_executor_event("runtime work turn spawning", &fields);

        self.mark_active_local_task(&local_task_id);
        let (request_user_input_tx, request_user_input_rx): (
            mpsc::Sender<Value>,
            CodexRequestUserInputReceiver,
        ) = mpsc::channel(1);
        if let Ok(mut requests) = self.active_request_user_inputs.lock() {
            requests.insert(local_task_id.clone(), request_user_input_tx);
        }
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (stopped_tx, stopped_rx) = oneshot::channel();
        self.set_active_turn_cancellation(
            local_task_id.clone(),
            ActiveTurnCancellation {
                cancel: cancel_tx,
                stopped: stopped_rx,
            },
        );
        let handler = self.clone();
        let turn_local_task_id = local_task_id.clone();
        let turn_handle = tokio::spawn(async move {
            emit_response_event(
                &handler.event_tx,
                &handler.device_id,
                "response.created",
                &turn_local_task_id,
                &request,
                json!({"response": {"status": "in_progress"}}),
            );

            handler.ensure_notification_router().await;
            let (notification_tx, mut notification_rx) = mpsc::unbounded_channel::<Value>();
            let mapper_handler = handler.clone();
            let mapper_local_task_id = turn_local_task_id.clone();
            let mapper_request = request.clone();
            let mapper_handle = tokio::spawn(async move {
                let mut event_mapper = CodexNotificationEventMapper::default();
                let mut cache_mapper = CodexNotificationCacheMapper::default();
                while let Some(message) = notification_rx.recv().await {
                    cache_mapper.map(
                        &mapper_handler.store,
                        &mapper_local_task_id,
                        &mapper_request,
                        &message,
                    );
                    event_mapper.map(
                        &mapper_handler.event_tx,
                        &mapper_handler.device_id,
                        &mapper_local_task_id,
                        &mapper_request,
                        message,
                    );
                }
            });
            let route_handler = handler.clone();
            let route_local_task_id = turn_local_task_id.clone();
            let thread_started: CodexThreadStartedCallback = Box::new(move |thread_id| {
                route_handler.record_local_task_thread(&route_local_task_id, &thread_id);
            });
            let active_turn_handler = handler.clone();
            let active_turn_local_task_id = turn_local_task_id.clone();
            let active_turn_started: CodexActiveTurnCallback =
                Box::new(move |thread_id, turn_id| {
                    active_turn_handler.record_active_codex_turn(
                        &active_turn_local_task_id,
                        thread_id,
                        turn_id,
                    );
                });
            let result = handler
                .codex_app_server
                .run_turn_with_cancel(
                    request.clone(),
                    CodexAppServerTurnOptions {
                        direct_thread_id,
                        fork_thread_id,
                        fork_thread_path,
                        resume_thread_id,
                        initial_thread_name,
                        initial_thread_goal,
                        notifications: Some(notification_tx),
                        cancellation: Some(cancel_rx),
                        request_user_input_answers: Some(request_user_input_rx),
                        thread_started: Some(thread_started),
                        active_turn_started: Some(active_turn_started),
                    },
                )
                .await;

            if matches!(result.as_ref(), Err(error) if error == CODEX_APP_SERVER_TURN_CANCELLED) {
                let _ = mapper_handle.await;
                handler.clear_active_turn_cancellation(&turn_local_task_id);
                handler.clear_active_codex_turn(&turn_local_task_id);
                handler.unmark_active_local_task(&turn_local_task_id);
                handler.mark_thread_event_routes_idle_for_local_task(&turn_local_task_id);
                if let Ok(mut requests) = handler.active_request_user_inputs.lock() {
                    requests.remove(&turn_local_task_id);
                }
                let _ = stopped_tx.send(());
                return;
            }

            let _ = mapper_handle.await;
            handler.handle_turn_result(&turn_local_task_id, &request, result);
            handler.clear_active_codex_turn(&turn_local_task_id);
            if let Ok(mut requests) = handler.active_request_user_inputs.lock() {
                requests.remove(&turn_local_task_id);
            }
            let _ = stopped_tx.send(());
        });
        drop(turn_handle);
    }

    pub(super) fn handle_turn_result(
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
                let thread_id = turn.thread_id.clone();
                self.register_thread_event_route(
                    &thread_id,
                    local_task_id.to_owned(),
                    request.clone(),
                    false,
                );
                self.finish_local_task(local_task_id, Some(thread_id.clone()), status);
                self.mark_thread_event_route_idle(&thread_id);
                self.register_codex_thread_workspace_root(&thread_id, request);
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
                        let mut fields = task_fields(&request.task_id, &request.subtask_id);
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
                self.mark_thread_event_routes_idle_for_local_task(local_task_id);
                self.finish_local_task(local_task_id, None, "failed");
                let mut fields = task_fields(&request.task_id, &request.subtask_id);
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

    pub(super) fn register_codex_thread_workspace_root(
        &self,
        thread_id: &str,
        request: &ExecutionRequest,
    ) {
        let Some(workspace_path) = request.cwd() else {
            return;
        };
        if infer_workspace_kind(workspace_path) == "chat" {
            return;
        }
        match register_codex_global_thread_workspace_root(thread_id, workspace_path) {
            Ok(Some(workspace_root)) => {
                log_executor_event(
                    "runtime work codex thread workspace root registered",
                    &[
                        ("thread_id", thread_id.to_owned()),
                        ("workspace_root", workspace_root),
                    ],
                );
            }
            Ok(None) => {}
            Err(error) => {
                log_executor_event(
                    "runtime work codex thread workspace root registration failed",
                    &[("thread_id", thread_id.to_owned()), ("error", error)],
                );
            }
        }
    }

    pub(super) async fn ensure_notification_router(&self) {
        if self
            .notification_router
            .lock()
            .expect("notification router lock should not be poisoned")
            .as_ref()
            .is_some_and(|task| !task.is_finished())
        {
            return;
        }

        let notification_rx = match self.codex_app_server.subscribe_notifications().await {
            Ok(receiver) => receiver,
            Err(error) => {
                log_executor_event(
                    "runtime work notification router subscribe failed",
                    &[("error", error)],
                );
                return;
            }
        };

        let mut router = self
            .notification_router
            .lock()
            .expect("notification router lock should not be poisoned");
        if router.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }

        let handler = self.clone();
        *router = Some(tokio::spawn(async move {
            handler.run_notification_router(notification_rx).await;
        }));
    }

    pub(super) async fn run_notification_router(
        &self,
        mut notification_rx: broadcast::Receiver<Value>,
    ) {
        loop {
            let message = match notification_rx.recv().await {
                Ok(message) => message,
                Err(broadcast::error::RecvError::Lagged(count)) => {
                    log_executor_event(
                        "runtime work notification router lagged",
                        &[("count", count.to_string())],
                    );
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    log_executor_event("runtime work notification router closed", &[]);
                    return;
                }
            };

            if message.get("method").and_then(Value::as_str) == Some("codex/app-server/exited") {
                log_executor_event("runtime work notification router app-server exited", &[]);
                return;
            }

            self.route_codex_notification(message);
        }
    }

    pub(super) fn route_codex_notification(&self, message: Value) {
        let thread_id =
            codex_notification_thread_id(&message).or_else(|| self.unscoped_route_thread_id());
        let Some(thread_id) = thread_id else {
            debug_unrouted_codex_notification(&message, "missing_thread_id");
            return;
        };

        if !self.thread_event_route_exists(&thread_id) {
            self.register_thread_event_route_from_store(&thread_id);
        }
        if !self.thread_event_route_exists(&thread_id)
            && codex_started_thread_id(&message).as_deref() == Some(thread_id.as_str())
        {
            self.promote_pending_thread_event_route(&thread_id);
        }

        let mut routes = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned");
        let Some(route) = routes.get_mut(&thread_id) else {
            debug_unrouted_codex_notification(&message, "missing_route");
            return;
        };
        if self.is_active_local_task(&route.local_task_id) {
            return;
        }

        if let Some(started_thread_id) = codex_started_thread_id(&message) {
            self.register_codex_thread_workspace_root(&started_thread_id, &route.request);
        }
        route
            .cache_mapper
            .map(&self.store, &route.local_task_id, &route.request, &message);
        route.event_mapper.map(
            &self.event_tx,
            &self.device_id,
            &route.local_task_id,
            &route.request,
            message,
        );
    }

    pub(super) fn register_thread_event_route(
        &self,
        thread_id: &str,
        local_task_id: String,
        request: ExecutionRequest,
        active: bool,
    ) {
        if thread_id.trim().is_empty() {
            return;
        }
        self.store.update_task(&local_task_id, |link| {
            link.thread_id = Some(thread_id.to_owned());
            link.updated_at = now_ms();
        });
        self.thread_list_cache.invalidate();
        let pending_id = pending_thread_event_route_id(&local_task_id);
        let mut routes = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned");
        let existing = routes
            .remove(thread_id)
            .or_else(|| routes.remove(&pending_id));
        let mut route = existing.unwrap_or_else(|| {
            RuntimeThreadEventRoute::new(local_task_id.clone(), request.clone(), active)
        });
        if active {
            route.event_mapper = CodexNotificationEventMapper::default();
            route.cache_mapper = CodexNotificationCacheMapper::default();
        }
        route.local_task_id = local_task_id;
        route.request = request;
        route.active = route.active || active;
        routes.insert(thread_id.to_owned(), route);
    }

    #[cfg(test)]
    pub(super) fn register_pending_thread_event_route(
        &self,
        local_task_id: String,
        request: ExecutionRequest,
    ) {
        let pending_id = pending_thread_event_route_id(&local_task_id);
        let mut routes = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned");
        if let Some(route) = routes.get_mut(&pending_id) {
            route.request = request;
            route.active = true;
            return;
        }
        routes.insert(
            pending_id,
            RuntimeThreadEventRoute::new(local_task_id, request, true),
        );
    }

    pub(super) fn record_local_task_thread(&self, local_task_id: &str, thread_id: &str) {
        if thread_id.trim().is_empty() {
            return;
        }
        self.store.update_task(local_task_id, |link| {
            link.thread_id = Some(thread_id.to_owned());
            link.updated_at = now_ms();
        });
        self.thread_list_cache.invalidate();
    }

    pub(super) fn register_thread_event_route_for_link(
        &self,
        link: &RuntimeTaskLink,
        active: bool,
    ) {
        let Some(thread_id) = runtime_session_id_from_link(link) else {
            return;
        };
        self.register_thread_event_route(
            &thread_id,
            link.local_task_id.clone(),
            runtime_event_request_from_link(link),
            active,
        );
    }

    pub(super) fn register_thread_event_route_from_store(&self, thread_id: &str) {
        if let Some(link) = self.local_task_by_thread_id(thread_id) {
            self.register_thread_event_route_for_link(&link, false);
        }
    }

    pub(super) fn thread_event_route_exists(&self, thread_id: &str) -> bool {
        self.thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned")
            .contains_key(thread_id)
    }

    pub(super) fn promote_pending_thread_event_route(&self, thread_id: &str) -> bool {
        if thread_id.trim().is_empty() {
            return false;
        }

        let mut routes = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned");
        if routes.contains_key(thread_id) {
            return true;
        }
        let mut pending_route_ids = routes
            .iter()
            .filter(|(route_id, route)| is_pending_thread_event_route_id(route_id) && route.active)
            .map(|(route_id, _)| route_id.clone());
        let Some(pending_route_id) = pending_route_ids.next() else {
            return false;
        };
        if pending_route_ids.next().is_some() {
            return false;
        }
        let Some(route) = routes.remove(&pending_route_id) else {
            return false;
        };
        let local_task_id = route.local_task_id.clone();
        routes.insert(thread_id.to_owned(), route);
        drop(routes);

        self.store.update_task(&local_task_id, |link| {
            link.thread_id = Some(thread_id.to_owned());
            link.updated_at = now_ms();
        });
        self.thread_list_cache.invalidate();
        true
    }

    pub(super) fn unscoped_route_thread_id(&self) -> Option<String> {
        let routes = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned");
        let mut active_routes = routes
            .iter()
            .filter(|(_, route)| route.active)
            .map(|(thread_id, _)| thread_id.clone());
        if let Some(thread_id) = active_routes.next() {
            if active_routes.next().is_some() {
                return None;
            }
            return Some(thread_id);
        }

        let mut route_ids = routes.keys().cloned();
        let thread_id = route_ids.next()?;
        if route_ids.next().is_some() {
            None
        } else {
            Some(thread_id)
        }
    }

    pub(super) fn mark_thread_event_route_idle(&self, thread_id: &str) {
        if let Some(route) = self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned")
            .get_mut(thread_id)
        {
            route.active = false;
        }
    }

    pub(super) fn mark_thread_event_routes_idle_for_local_task(&self, local_task_id: &str) {
        for route in self
            .thread_event_routes
            .lock()
            .expect("thread event route lock should not be poisoned")
            .values_mut()
        {
            if route.local_task_id == local_task_id {
                route.active = false;
            }
        }
    }
}
