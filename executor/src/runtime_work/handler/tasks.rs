// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn fork_task_at_turn(&self, payload: Value) -> Result<Value, AppIpcError> {
        let source = self.task_link_from_payload(&payload, false).await?;
        if source.running && self.is_active_local_task(&source.local_task_id) {
            return Ok(
                json!({"success": false, "accepted": false, "error": "runtime task is already running", "code": "bad_request"}),
            );
        }
        let requested_turn_id = string_field(&payload, "lastTurnId")
            .or_else(|| string_field(&payload, "last_turn_id"))
            .ok_or_else(|| AppIpcError::new("bad_request", "lastTurnId is required"))?;
        let source_thread_id = runtime_session_id_from_payload(&payload)
            .or_else(|| runtime_session_id_from_link(&source))
            .ok_or_else(|| AppIpcError::new("bad_request", "source task session is not ready"))?;
        let read_response = self
            .call_codex_thread_method(
                "thread/read",
                json!({"threadId": source_thread_id, "includeTurns": true}),
            )
            .await
            .map_err(|error| AppIpcError::new("fork_failed", error))?;
        let thread = read_response.get("thread").unwrap_or(&read_response);
        let last_turn_id = thread
            .get("turns")
            .and_then(Value::as_array)
            .and_then(|turns| {
                turns.iter().find_map(|turn| {
                    let id = string_field(turn, "id")?;
                    let subtask_id = string_field(turn, "subtaskId")
                        .or_else(|| string_field(turn, "subtask_id"));
                    (id == requested_turn_id || subtask_id.as_deref() == Some(&requested_turn_id))
                        .then_some(id)
                })
            })
            .ok_or_else(|| AppIpcError::new("bad_request", "fork turn was not found"))?;
        let response = match self
            .call_codex_thread_method(
                "thread/fork",
                json!({
                    "threadId": source_thread_id,
                    "lastTurnId": last_turn_id,
                    "cwd": source.workspace_path,
                    "excludeTurns": true,
                }),
            )
            .await
        {
            Ok(response) => response,
            Err(error) => return Ok(task_action_failure(&source, error)),
        };
        let thread = response.get("thread").unwrap_or(&response);
        let thread_id = string_field(thread, "id").ok_or_else(|| {
            AppIpcError::new("invalid_response", "thread/fork did not return thread.id")
        })?;
        let local_task_id = thread_id.clone();
        let title = string_field(&payload, "title").unwrap_or_else(|| source.title.clone());
        let mut link = RuntimeTaskLink::new_pending(
            local_task_id.clone(),
            source.workspace_path.clone(),
            title,
        );
        link.thread_id = Some(thread_id);
        link.running = false;
        link.status = "active".to_owned();
        link.thread_status = "idle".to_owned();
        link.turn_status = Some("completed".to_owned());
        link.parent = Some(
            json!({"taskId": source.local_task_id, "threadId": source_thread_id, "lastTurnId": last_turn_id}),
        );
        self.upsert_local_task(link);
        Ok(json!({
            "success": true,
            "accepted": true,
            "source": {"deviceId": self.device_id, "taskId": source.local_task_id},
            "target": {"deviceId": self.device_id, "taskId": local_task_id},
            "runtime": "codex",
        }))
    }

    pub(super) async fn create_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = id_field(&payload, "taskId")
            .or_else(|| id_field(&payload, "task_id"))
            .unwrap_or_else(|| format!("codex-local-{}", now_ms()));
        let payload_workspace_path = workspace_path(&payload);
        let title = string_field(&payload, "title")
            .or_else(|| string_field(&payload, "message"))
            .unwrap_or_else(|| local_task_id.clone());
        let mut request = execution_request(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "executionRequest is required"))?;
        apply_runtime_payload_metadata(&mut request, &payload);
        let workspace_path = payload_workspace_path
            .or_else(|| request.cwd().map(str::to_owned))
            .or_else(|| standalone_chat_workspace_path(&local_task_id, &request))
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        if request.project_workspace_path.is_none() {
            request.project_workspace_path = Some(workspace_path.clone());
        }

        let mut link = RuntimeTaskLink::new_pending(
            local_task_id.clone(),
            workspace_path.clone(),
            title.clone(),
        );
        link.ephemeral = request.ephemeral || bool_field(&payload, "ephemeral").unwrap_or(false);
        set_runtime_handle_model_selection(&mut link.runtime_handle, &payload);
        if let Some(message) = cached_user_message(&local_task_id, &request, &payload) {
            set_runtime_handle_messages(&mut link.runtime_handle, vec![message]);
        }
        let runtime_handle = runtime_handle_json(&link);
        self.upsert_local_task(link);
        self.schedule_worktree_prune();
        let initial_thread_goal = initial_thread_goal_from_payload(&payload);
        let mut side_source = side_source_thread(&payload);
        if let Some(source) = &mut side_source {
            if source.thread_path.is_none() {
                source.thread_path = self.thread_path_for_id(&source.thread_id).await;
            }
        }
        self.spawn_turn(SpawnTurnRequest {
            local_task_id: local_task_id.clone(),
            request,
            direct_thread_id: None,
            fork_thread_id: side_source.as_ref().map(|source| source.thread_id.clone()),
            fork_thread_path: side_source.and_then(|source| source.thread_path),
            resume_thread_id: None,
            initial_thread_name: Some(title),
            initial_thread_goal,
        });

        Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": self.device_id,
            "taskId": local_task_id,
            "workspacePath": workspace_path,
            "runtime": "codex",
            "runtimeHandle": runtime_handle,
        }))
    }

    pub(super) async fn send_message(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let existing_link = self.local_task_link(&local_task_id);
        let payload_execution_request = execution_request(&payload);
        let has_execution_request = payload_execution_request.is_some();
        if let Some(response) = request_user_input_response(&payload) {
            return self
                .send_request_user_input_response(&local_task_id, response)
                .await;
        }
        if existing_link
            .as_ref()
            .is_some_and(|link| link.running && self.is_active_local_task(&link.local_task_id))
        {
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
        if let Err(error) = self.worktrees.restore_if_known(Path::new(&workspace_path)) {
            return Ok(json!({
                "success": false,
                "accepted": false,
                "error": error,
                "code": "worktree_restore_required",
                "taskId": local_task_id,
                "workspacePath": workspace_path,
            }));
        }
        let mut request = payload_execution_request
            .ok_or_else(|| AppIpcError::new("bad_request", "executionRequest is required"))?;
        apply_runtime_payload_metadata(&mut request, &payload);
        request.new_session = false;
        if request.project_workspace_path.is_none() && !workspace_path.is_empty() {
            request.project_workspace_path = Some(workspace_path.clone());
        }
        let recovered_link = self
            .recover_send_task_link(&payload, &local_task_id, existing_link.as_ref())
            .await;
        let Some(thread_id) = runtime_session_id_from_payload(&payload)
            .or_else(|| {
                existing_link
                    .as_ref()
                    .and_then(runtime_session_id_from_link)
            })
            .or_else(|| {
                recovered_link
                    .as_ref()
                    .and_then(runtime_session_id_from_link)
            })
        else {
            return Ok(json!({
                "success": false,
                "error": "runtime task session is not ready",
                "code": "missing_runtime_session",
                "taskId": local_task_id,
                "runtime": "codex",
            }));
        };

        let mut fields = task_fields(&request.task_id, &request.subtask_id);
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
        self.schedule_worktree_prune();
        let link_for_send = existing_link.as_ref().or(recovered_link.as_ref());
        let ephemeral = request.ephemeral || link_for_send.is_some_and(|link| link.ephemeral);
        let direct_thread_id = ephemeral.then(|| thread_id.clone());
        let resume_thread_id = (!ephemeral).then_some(thread_id);

        self.spawn_turn(SpawnTurnRequest {
            local_task_id: local_task_id.clone(),
            request,
            direct_thread_id,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id,
            initial_thread_name: None,
            initial_thread_goal: None,
        });

        Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": self.device_id,
            "taskId": local_task_id,
            "runtime": "codex",
        }))
    }

    pub(super) async fn interrupt_and_send(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        self.resolve_pending_request_user_input_for_stop(&local_task_id);
        if !self.abort_active_turn(&local_task_id).await {
            return Ok(json!({
                "success": false,
                "accepted": false,
                "taskId": local_task_id,
                "runtime": "codex",
                "error": "runtime turn did not stop within timeout",
                "code": "interrupt_timeout",
            }));
        }
        self.send_message(payload).await
    }

    pub(super) async fn rollback_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let requested_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let existing_link = self.task_link_from_payload(&payload, false).await?;
        let local_task_id = existing_link.local_task_id.clone();
        if existing_link.running && self.is_active_local_task(&existing_link.local_task_id) {
            return Ok(json!({
                "success": false,
                "accepted": false,
                "taskId": local_task_id,
                "runtime": "codex",
                "error": "runtime task is already running",
                "code": "bad_request",
            }));
        }

        let mut request = execution_request(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "executionRequest is required"))?;
        let workspace_path =
            workspace_path(&payload).unwrap_or_else(|| existing_link.workspace_path.clone());
        apply_runtime_payload_metadata(&mut request, &payload);
        request.new_session = false;
        if request.project_workspace_path.is_none() && !workspace_path.is_empty() {
            request.project_workspace_path = Some(workspace_path.clone());
        }
        let Some(thread_id) = runtime_session_id_from_payload(&payload)
            .or_else(|| runtime_session_id_from_link(&existing_link))
        else {
            return Ok(task_goal_missing_session(&existing_link));
        };

        let mut fields = task_fields(&request.task_id, &request.subtask_id);
        fields.push(("requested_task_id", requested_task_id));
        fields.push(("local_task_id", local_task_id.clone()));
        fields.push(("thread_id", thread_id.clone()));
        fields.push(("workspace_path", workspace_path.clone()));
        fields.push(("prompt_len", prompt_text(&request.prompt).len().to_string()));
        if let Some(cwd) = request.cwd() {
            fields.push(("cwd", cwd.to_owned()));
        }
        log_executor_event("runtime work rollback prepared", &fields);

        if let Err(error) = self
            .call_codex_thread_method(
                "thread/rollback",
                json!({
                    "threadId": thread_id,
                    "numTurns": 1,
                }),
            )
            .await
        {
            return Ok(task_action_failure(&existing_link, error));
        }

        self.trim_runtime_handle_after_rollback(&local_task_id);
        self.mark_task_running_for_send(
            &local_task_id,
            &thread_id,
            &workspace_path,
            &request,
            &payload,
        );
        self.spawn_turn(SpawnTurnRequest {
            local_task_id: local_task_id.clone(),
            request,
            direct_thread_id: Some(thread_id),
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: None,
            initial_thread_name: None,
            initial_thread_goal: None,
        });

        Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": self.device_id,
            "taskId": local_task_id,
            "runtime": "codex",
        }))
    }

    pub(super) async fn send_guidance(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let message = string_field(&payload, "message")
            .or_else(|| string_field(&payload, "guidance"))
            .map(|value| value.trim().to_owned())
            .unwrap_or_default();
        let steer_input = guidance_input_items(&message, payload.get("attachments"));
        if steer_input.is_empty() {
            return Err(AppIpcError::new(
                "bad_request",
                "message or image attachment is required",
            ));
        }
        let Some(active_turn) = self.wait_for_active_codex_turn(&local_task_id).await else {
            return Ok(json!({
                "success": false,
                "accepted": false,
                "error": "no active turn to guide",
                "code": "no_active_turn",
                "taskId": local_task_id,
                "runtime": "codex",
            }));
        };

        let guidance_id = string_field(&payload, "client_guidance_id")
            .or_else(|| string_field(&payload, "clientGuidanceId"))
            .unwrap_or_else(|| format!("guidance-{}", now_ms()));
        let additional_context = payload
            .get("additionalContext")
            .or_else(|| payload.get("additional_context"))
            .filter(|value| value.is_object())
            .cloned();
        match self
            .codex_app_server
            .steer_turn(
                &active_turn.thread_id,
                &active_turn.turn_id,
                Value::Array(steer_input),
                additional_context,
            )
            .await
        {
            Ok(turn_id) => Ok(json!({
                "success": true,
                "accepted": true,
                "guidance_id": guidance_id,
                "guidanceId": guidance_id,
                "taskId": local_task_id,
                "turnId": turn_id,
                "runtime": "codex",
            })),
            Err(error) => {
                let code = codex_guidance_failure_code(&error);
                Ok(json!({
                    "success": false,
                    "accepted": false,
                    "error": error,
                    "code": code,
                    "taskId": local_task_id,
                    "runtime": "codex",
                }))
            }
        }
    }

    pub(super) async fn compact_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let link = self.task_link_from_payload(&payload, false).await?;
        let Some(thread_id) = runtime_session_id_from_payload(&payload)
            .or_else(|| runtime_session_id_from_link(&link))
        else {
            return Ok(task_action_failure(
                &link,
                "runtime task session is not ready".to_owned(),
            ));
        };

        let thread_id = match self.resume_codex_thread_for_action(&link, &thread_id).await {
            Ok(resumed_thread_id) => resumed_thread_id,
            Err(error) => return Ok(task_action_failure(&link, error)),
        };
        self.register_thread_event_route(
            &thread_id,
            link.local_task_id.clone(),
            runtime_event_request_from_link(&link),
            true,
        );
        match self
            .call_codex_thread_method("thread/compact/start", json!({"threadId": thread_id}))
            .await
        {
            Ok(_) => {
                self.store.update_task(&local_task_id, |stored| {
                    stored.updated_at = now_ms();
                });
                Ok(task_action_success(&link))
            }
            Err(error) => Ok(task_action_failure(&link, error)),
        }
    }

    pub(super) async fn resume_codex_thread_for_action(
        &self,
        link: &RuntimeTaskLink,
        thread_id: &str,
    ) -> Result<String, String> {
        let mut params = Map::new();
        params.insert("threadId".to_owned(), Value::String(thread_id.to_owned()));
        params.insert(
            "approvalPolicy".to_owned(),
            Value::String("never".to_owned()),
        );
        params.insert("excludeTurns".to_owned(), Value::Bool(true));
        if !link.workspace_path.trim().is_empty() {
            params.insert("cwd".to_owned(), Value::String(link.workspace_path.clone()));
        }
        if let Some(thread_path) = runtime_thread_path_from_link(link) {
            params.insert("path".to_owned(), Value::String(thread_path));
        }

        let response = self
            .call_codex_thread_method_without_list_invalidation(
                "thread/resume",
                Value::Object(params),
            )
            .await?;
        Ok(response
            .get("thread")
            .and_then(|thread| string_field(thread, "id"))
            .unwrap_or_else(|| thread_id.to_owned()))
    }

    pub(super) async fn send_request_user_input_response(
        &self,
        local_task_id: &str,
        response: Value,
    ) -> Result<Value, AppIpcError> {
        let sender = self
            .active_request_user_inputs
            .lock()
            .ok()
            .and_then(|requests| requests.get(local_task_id).cloned());
        let Some(sender) = sender else {
            return Ok(json!({
                "success": false,
                "error": "request_user_input is not pending",
                "code": "missing_request_user_input",
                "taskId": local_task_id,
                "runtime": "codex",
            }));
        };
        if sender.send(response).await.is_err() {
            return Ok(json!({
                "success": false,
                "error": "request_user_input response channel is closed",
                "code": "closed_request_user_input",
                "taskId": local_task_id,
                "runtime": "codex",
            }));
        }
        Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": self.device_id,
            "taskId": local_task_id,
            "runtime": "codex",
        }))
    }

    pub(super) async fn cancel_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let link = self
            .store
            .update_task(&local_task_id, |link| {
                link.status = "cancelled".to_owned();
                link.running = false;
                link.thread_status = "idle".to_owned();
                link.turn_status = Some("interrupted".to_owned());
                link.updated_at = now_ms();
                link.completed_at = Some(link.updated_at);
            })
            .or_else(|| self.local_task_link(&local_task_id));
        self.resolve_pending_request_user_input_for_stop(&local_task_id);
        if !self.abort_active_turn(&local_task_id).await {
            return Ok(json!({
                "success": false,
                "accepted": false,
                "taskId": local_task_id,
                "runtime": "codex",
                "error": "runtime task did not stop within timeout",
                "code": "cancel_timeout",
            }));
        }

        Ok(match link {
            Some(link) => task_action_success(&link),
            None => json!({
                "success": true,
                "accepted": true,
                "taskId": local_task_id,
                "runtime": "codex",
            }),
        })
    }

    pub(super) fn resolve_pending_request_user_input_for_stop(&self, local_task_id: &str) {
        let sender = self
            .active_request_user_inputs
            .lock()
            .ok()
            .and_then(|requests| requests.get(local_task_id).cloned());
        if let Some(sender) = sender {
            let _ = sender.try_send(empty_request_user_input_response());
        }
    }

    pub(super) fn mark_task_running_for_send(
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
            link.thread_status = "active".to_owned();
            link.turn_status = Some("inProgress".to_owned());
            link.ephemeral = link.ephemeral || request.ephemeral;
            link.updated_at = now_ms();
            set_runtime_handle_model_selection(&mut link.runtime_handle, payload);
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
        link.ephemeral = request.ephemeral;
        set_runtime_handle_model_selection(&mut link.runtime_handle, payload);
        if let Some(message) = message {
            set_runtime_handle_messages(&mut link.runtime_handle, vec![message]);
        }
        self.upsert_local_task(link);
    }

    pub(super) fn trim_runtime_handle_after_rollback(&self, local_task_id: &str) {
        self.store.update_task(local_task_id, |link| {
            let mut messages = cached_messages(link);
            if let Some(index) = messages.iter().rposition(|message| {
                string_field(message, "role").is_some_and(|role| role.eq_ignore_ascii_case("user"))
            }) {
                messages.truncate(index);
                set_runtime_handle_messages(&mut link.runtime_handle, messages);
                link.updated_at = now_ms();
            }
        });
    }
}
