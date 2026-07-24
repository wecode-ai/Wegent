// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn hook_user(request: &ExecutionRequest) -> HookUser {
    let nested_user = request.extra.get("user").and_then(Value::as_object);
    let id = request
        .extra
        .get("user_id")
        .or_else(|| nested_user.and_then(|user| user.get("id")))
        .and_then(hook_user_id);
    let name = request
        .user_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            nested_user.and_then(|user| {
                ["name", "user_name", "username"]
                    .iter()
                    .find_map(|key| user.get(*key).and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
        })
        .unwrap_or("anonymous")
        .to_owned();
    HookUser { id, name }
}

fn hook_user_id(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_owned())
        }
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

impl RuntimeWorkRpcHandler {
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
            let hook_turn = Arc::new(Mutex::new(None::<ActiveCodexTurn>));
            let mapper_hook_turn = Arc::clone(&hook_turn);
            let mapper_handle = tokio::spawn(async move {
                let mut event_mapper = CodexNotificationEventMapper::default();
                while let Some(message) = notification_rx.recv().await {
                    mapper_handler
                        .sync_runtime_task_goal_from_notification(&mapper_local_task_id, &message);
                    let active_turn = mapper_hook_turn
                        .lock()
                        .expect("hook turn context lock should not be poisoned")
                        .clone();
                    if let (Some(active_turn), Some(cwd)) = (active_turn, mapper_request.cwd()) {
                        let resolved_hook_user = hook_user(&mapper_request);
                        let context = CodexHookContext {
                            user: resolved_hook_user.clone(),
                            session_id: active_turn.thread_id,
                            turn_id: active_turn.turn_id,
                            cwd: PathBuf::from(cwd),
                            model: string_field(&mapper_request.model_config, "model_id"),
                            permission_mode: "workspace-write".to_owned(),
                        };
                        match post_tool_use_from_notification(&context, &message) {
                            Ok(Some(input)) => {
                                log_executor_event(
                                    "runtime work hook identity resolved",
                                    &[
                                        (
                                            "request_user_name",
                                            mapper_request
                                                .user_name
                                                .clone()
                                                .unwrap_or_else(|| "<none>".to_owned()),
                                        ),
                                        ("hook_user_name", resolved_hook_user.name.clone()),
                                    ],
                                );
                                mapper_handler.hook_service.dispatch(input).await
                            }
                            Ok(None) => {}
                            Err(error) => log_executor_event(
                                "runtime work hook notification mapping failed",
                                &[("error", error.to_string())],
                            ),
                        }
                    }
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
            let active_turn_subtask_id = request.subtask_id.to_string();
            let callback_hook_turn = Arc::clone(&hook_turn);
            let active_turn_started: CodexActiveTurnCallback =
                Box::new(move |thread_id, turn_id| {
                    *callback_hook_turn
                        .lock()
                        .expect("hook turn context lock should not be poisoned") =
                        Some(ActiveCodexTurn {
                            thread_id: thread_id.clone(),
                            turn_id: turn_id.clone(),
                        });
                    active_turn_handler.record_active_codex_turn(
                        &active_turn_local_task_id,
                        thread_id,
                        turn_id.clone(),
                    );
                    active_turn_handler.record_runtime_turn_id(
                        &active_turn_local_task_id,
                        &active_turn_subtask_id,
                        &turn_id,
                    );
                });
            let finished_turn_handler = handler.clone();
            let finished_turn_local_task_id = turn_local_task_id.clone();
            let active_turn_finished: CodexActiveTurnFinishedCallback = Box::new(move || {
                finished_turn_handler.clear_active_codex_turn(&finished_turn_local_task_id);
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
                        active_turn_finished: Some(active_turn_finished),
                    },
                )
                .await;

            if matches!(result.as_ref(), Err(error) if error == CODEX_APP_SERVER_TURN_CANCELLED) {
                emit_response_event(
                    &handler.event_tx,
                    &handler.device_id,
                    "response.incomplete",
                    &turn_local_task_id,
                    &request,
                    json!({
                        "type": "cancelled",
                        "error": {"message": "cancelled"},
                    }),
                );
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_standard_hook_user_from_execution_request() {
        let mut request = ExecutionRequest {
            user_name: Some("alice".to_owned()),
            ..ExecutionRequest::default()
        };
        request.extra.insert("user_id".to_owned(), json!(42));

        assert_eq!(
            hook_user(&request),
            HookUser {
                id: Some("42".to_owned()),
                name: "alice".to_owned(),
            }
        );
    }

    #[test]
    fn resolves_anonymous_hook_user_without_private_config_fallbacks() {
        assert_eq!(
            hook_user(&ExecutionRequest::default()),
            HookUser {
                id: None,
                name: "anonymous".to_owned(),
            }
        );
    }
}
