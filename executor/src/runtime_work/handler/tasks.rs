// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn fork_task_at_turn(&self, payload: Value) -> Result<Value, AppIpcError> {
        let source = self.task_link_from_payload(&payload, false).await?;
        let requested_turn_id = string_field(&payload, "lastTurnId")
            .or_else(|| string_field(&payload, "last_turn_id"))
            .ok_or_else(|| AppIpcError::new("bad_request", "lastTurnId is required"))?;
        let source_thread_id = runtime_session_id_from_payload(&payload)
            .or_else(|| runtime_session_id_from_link(&source))
            .ok_or_else(|| AppIpcError::new("bad_request", "source task session is not ready"))?;
        log_executor_event(
            "runtime task fork starting",
            &[
                ("local_task_id", source.local_task_id.clone()),
                ("source_thread_id", source_thread_id.clone()),
                ("requested_turn_id", requested_turn_id.clone()),
            ],
        );
        let Some(last_turn_id) = resolve_codex_turn_id(&source, &requested_turn_id) else {
            let mapping_keys = source
                .runtime_handle
                .get("turnIdsBySubtask")
                .and_then(Value::as_object)
                .map(|mappings| mappings.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            log_executor_event(
                "runtime task fork rejected",
                &[
                    ("reason", "turn_not_found".to_owned()),
                    ("local_task_id", source.local_task_id.clone()),
                    ("requested_turn_id", requested_turn_id.clone()),
                    ("mapping_keys", mapping_keys.join(",")),
                ],
            );
            return Ok(json!({
                "success": false,
                "accepted": false,
                "error": "fork turn was not found",
                "code": "bad_request",
            }));
        };
        log_executor_event(
            "runtime task fork turn resolved",
            &[
                ("local_task_id", source.local_task_id.clone()),
                ("source_thread_id", source_thread_id.clone()),
                ("requested_turn_id", requested_turn_id),
                ("last_turn_id", last_turn_id.clone()),
            ],
        );
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
            Err(error) => {
                log_executor_event(
                    "runtime task fork failed",
                    &[
                        ("local_task_id", source.local_task_id.clone()),
                        ("source_thread_id", source_thread_id),
                        ("last_turn_id", last_turn_id),
                        ("error", error.clone()),
                    ],
                );
                return Ok(task_action_failure(&source, error));
            }
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
        link.parent = Some(
            json!({"taskId": source.local_task_id, "threadId": source_thread_id, "lastTurnId": last_turn_id}),
        );
        self.upsert_local_task(link);
        log_executor_event(
            "runtime task fork completed",
            &[
                ("local_task_id", source.local_task_id.clone()),
                ("target_task_id", local_task_id.clone()),
            ],
        );
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
        if let (Some(project_key), Some(project_name)) = (
            request.runtime_project_key.as_deref(),
            request.runtime_project_name.as_deref(),
        ) {
            if !request.runtime_workspace_roots.is_empty() {
                upsert_codex_global_local_project(
                    project_key,
                    project_name,
                    &request.runtime_workspace_roots,
                    None,
                )
                .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
            }
        }
        let workspace_path = payload_workspace_path
            .or_else(|| request.cwd().map(str::to_owned))
            .or_else(|| standalone_chat_workspace_path(&local_task_id, &request))
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        if request.project_workspace_path.is_none() {
            request.project_workspace_path = Some(workspace_path.clone());
        }
        self.apply_project_workspace_roots(&mut request);

        let mut link = RuntimeTaskLink::new_pending(
            local_task_id.clone(),
            workspace_path.clone(),
            title.clone(),
        );
        link.ephemeral = request.ephemeral || bool_field(&payload, "ephemeral").unwrap_or(false);
        link.runtime_project_key = request.runtime_project_key.clone();
        link.runtime_workspace_roots = request.runtime_workspace_roots.clone();
        set_runtime_handle_model_selection(&mut link.runtime_handle, &payload);
        if let (Some(runtime_handle), Some(project_id)) = (
            link.runtime_handle.as_object_mut(),
            cloud_project_id(&request),
        ) {
            runtime_handle.insert("cloudProjectId".to_owned(), project_id);
        }
        if let Some(message) = cached_user_message(&local_task_id, &request, &payload) {
            set_runtime_handle_messages(&mut link.runtime_handle, vec![message]);
        }
        if let Some(presentation) = user_message_presentation(&payload) {
            append_runtime_handle_user_message_presentation(&mut link.runtime_handle, presentation);
        }
        if let Some(supervisor) = payload
            .get("initialSupervisor")
            .or_else(|| payload.get("initial_supervisor"))
        {
            link.supervisor = Some(super::supervisor::configured_supervisor(supervisor, None)?);
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

    pub(super) fn record_runtime_turn_id(
        &self,
        local_task_id: &str,
        subtask_id: &str,
        turn_id: &str,
    ) {
        self.store.update_task(local_task_id, |link| {
            let Some(runtime_handle) = link.runtime_handle.as_object_mut() else {
                link.runtime_handle = json!({
                    "lastTurnId": turn_id,
                    "turnIdsBySubtask": {subtask_id: turn_id},
                });
                return;
            };
            runtime_handle.insert("lastTurnId".to_owned(), Value::String(turn_id.to_owned()));
            let mappings = runtime_handle
                .entry("turnIdsBySubtask")
                .or_insert_with(|| json!({}));
            if let Some(mappings) = mappings.as_object_mut() {
                mappings.insert(subtask_id.to_owned(), Value::String(turn_id.to_owned()));
            }
        });
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
            .is_some_and(|link| self.is_active_local_task(&link.local_task_id))
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
        if let Some(link) = existing_link.as_ref() {
            mark_runtime_model_switch(&mut request, link, &payload);
        }
        if let Some(link) = existing_link.as_ref() {
            restore_cloud_project_id(&mut request, &link.runtime_handle);
        }
        request.new_session = false;
        if request.runtime_project_key.is_none() {
            request.runtime_project_key = existing_link
                .as_ref()
                .and_then(|link| link.runtime_project_key.clone());
        }
        if request.runtime_workspace_roots.is_empty() {
            request.runtime_workspace_roots = existing_link
                .as_ref()
                .map(|link| link.runtime_workspace_roots.clone())
                .unwrap_or_default();
        }
        if request.project_workspace_path.is_none() && !workspace_path.is_empty() {
            request.project_workspace_path = Some(workspace_path.clone());
        }
        self.apply_project_workspace_roots(&mut request);
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
        let initial_thread_goal = initial_thread_goal_from_payload(&payload);

        self.spawn_turn(SpawnTurnRequest {
            local_task_id: local_task_id.clone(),
            request,
            direct_thread_id,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id,
            initial_thread_name: None,
            initial_thread_goal,
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
        if self.is_active_local_task(&existing_link.local_task_id) {
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
        mark_runtime_model_switch(&mut request, &existing_link, &payload);
        restore_cloud_project_id(&mut request, &existing_link.runtime_handle);
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
        log_executor_event(
            "runtime guidance requested",
            &[("local_task_id", local_task_id.clone())],
        );
        let Some(mut active_turn) = self.wait_for_active_codex_turn(&local_task_id).await else {
            log_executor_event(
                "runtime guidance rejected",
                &[
                    ("local_task_id", local_task_id.clone()),
                    ("code", "no_active_turn".to_owned()),
                    (
                        "active_local_task",
                        self.is_active_local_task(&local_task_id).to_string(),
                    ),
                ],
            );
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
        let steer_result = self
            .codex_app_server
            .steer_turn(
                &active_turn.thread_id,
                &active_turn.turn_id,
                Some(guidance_id.clone()),
                Value::Array(steer_input.clone()),
                additional_context.clone(),
            )
            .await;
        let steer_result = match steer_result {
            Err(error) => {
                let Some(actual_turn_id) = active_turn_id_from_steer_mismatch(&error) else {
                    return Ok(runtime_guidance_failure(
                        &local_task_id,
                        &active_turn,
                        error,
                    ));
                };
                if actual_turn_id == active_turn.turn_id {
                    return Ok(runtime_guidance_failure(
                        &local_task_id,
                        &active_turn,
                        error,
                    ));
                }
                log_executor_event(
                    "runtime guidance active turn corrected",
                    &[
                        ("local_task_id", local_task_id.clone()),
                        ("thread_id", active_turn.thread_id.clone()),
                        ("previous_turn_id", active_turn.turn_id.clone()),
                        ("turn_id", actual_turn_id.clone()),
                    ],
                );
                self.record_active_codex_turn(
                    &local_task_id,
                    active_turn.execution_id,
                    active_turn.thread_id.clone(),
                    actual_turn_id.clone(),
                );
                active_turn.turn_id = actual_turn_id.clone();
                self.codex_app_server
                    .steer_turn(
                        &active_turn.thread_id,
                        &actual_turn_id,
                        Some(guidance_id.clone()),
                        Value::Array(steer_input),
                        additional_context,
                    )
                    .await
            }
            result => result,
        };
        match steer_result {
            Ok(turn_id) => {
                self.record_active_codex_turn(
                    &local_task_id,
                    active_turn.execution_id,
                    active_turn.thread_id.clone(),
                    turn_id.clone(),
                );
                log_executor_event(
                    "runtime guidance accepted",
                    &[
                        ("local_task_id", local_task_id.clone()),
                        ("thread_id", active_turn.thread_id.clone()),
                        ("turn_id", turn_id.clone()),
                    ],
                );
                Ok(json!({
                    "success": true,
                    "accepted": true,
                    "guidance_id": guidance_id,
                    "guidanceId": guidance_id,
                    "taskId": local_task_id,
                    "turnId": turn_id,
                    "runtime": "codex",
                }))
            }
            Err(error) => Ok(runtime_guidance_failure(
                &local_task_id,
                &active_turn,
                error,
            )),
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
        params.insert("approvalPolicy".to_owned(), codex_runtime_approval_policy());
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
            .and_then(|requests| requests.get(local_task_id).cloned())
            .map(|request| request.sender);
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
            .and_then(|requests| requests.get(local_task_id).cloned())
            .map(|request| request.sender);
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
        let presentation = user_message_presentation(payload);
        let updated = self.store.update_task(local_task_id, |link| {
            link.thread_id = Some(thread_id.to_owned());
            clear_runtime_handle_messages(&mut link.runtime_handle);
            if let Some(presentation) = presentation.clone() {
                append_runtime_handle_user_message_presentation(
                    &mut link.runtime_handle,
                    presentation,
                );
            }
            link.workspace_path = workspace_path.to_owned();
            link.ephemeral = link.ephemeral || request.ephemeral;
            if request.runtime_project_key.is_some() {
                link.runtime_project_key = request.runtime_project_key.clone();
            }
            if !request.runtime_workspace_roots.is_empty() {
                link.runtime_workspace_roots = request.runtime_workspace_roots.clone();
            }
            link.updated_at = now_ms();
            set_runtime_handle_model_selection(&mut link.runtime_handle, payload);
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
        link.runtime_project_key = request.runtime_project_key.clone();
        link.runtime_workspace_roots = request.runtime_workspace_roots.clone();
        set_runtime_handle_model_selection(&mut link.runtime_handle, payload);
        if let Some(presentation) = presentation {
            append_runtime_handle_user_message_presentation(&mut link.runtime_handle, presentation);
        }
        self.upsert_local_task(link);
    }
}

pub(super) fn runtime_model_selection_changed(link: &RuntimeTaskLink, payload: &Value) -> bool {
    let previous = model_selection_identity(
        link.runtime_handle
            .get("modelSelection")
            .or_else(|| link.runtime_handle.get("model_selection")),
    );
    let next = model_selection_identity(
        payload
            .get("modelSelection")
            .or_else(|| payload.get("model_selection")),
    );
    previous.is_some() && next.is_some() && previous != next
}

pub(super) fn mark_runtime_model_switch(
    request: &mut ExecutionRequest,
    link: &RuntimeTaskLink,
    payload: &Value,
) {
    if runtime_model_selection_changed(link, payload) {
        request
            .extra
            .insert("wework_model_switched".to_owned(), Value::Bool(true));
    }
}

fn model_selection_identity(selection: Option<&Value>) -> Option<(String, Option<String>)> {
    let selection = selection?.as_object()?;
    let model_name = selection
        .get("modelName")
        .or_else(|| selection.get("model_name"))
        .and_then(Value::as_str)?
        .trim();
    if model_name.is_empty() {
        return None;
    }
    let model_type = selection
        .get("modelType")
        .or_else(|| selection.get("model_type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    Some((model_name.to_owned(), model_type))
}

fn runtime_guidance_failure(
    local_task_id: &str,
    active_turn: &ActiveCodexTurn,
    error: String,
) -> Value {
    let code = codex_guidance_failure_code(&error);
    log_executor_event(
        "runtime guidance rejected",
        &[
            ("local_task_id", local_task_id.to_owned()),
            ("code", code.to_owned()),
            ("thread_id", active_turn.thread_id.clone()),
            ("turn_id", active_turn.turn_id.clone()),
        ],
    );
    json!({
        "success": false,
        "accepted": false,
        "error": error,
        "code": code,
        "taskId": local_task_id,
        "runtime": "codex",
    })
}

pub(super) fn resolve_codex_turn_id(
    link: &RuntimeTaskLink,
    requested_turn_id: &str,
) -> Option<String> {
    let mappings = link
        .runtime_handle
        .get("turnIdsBySubtask")
        .and_then(Value::as_object);
    if let Some(turn_id) = mappings
        .and_then(|mappings| mappings.get(requested_turn_id))
        .and_then(Value::as_str)
    {
        return Some(turn_id.to_owned());
    }
    if mappings.is_some_and(|mappings| {
        mappings
            .values()
            .any(|turn_id| turn_id.as_str() == Some(requested_turn_id))
    }) || is_codex_thread_id(requested_turn_id)
    {
        return Some(requested_turn_id.to_owned());
    }
    if let Some(turn_id) = synthetic_transcript_turn_id_base(requested_turn_id) {
        if mappings.is_some_and(|mappings| {
            mappings
                .values()
                .any(|mapped_turn_id| mapped_turn_id.as_str() == Some(turn_id))
        }) || is_codex_thread_id(turn_id)
        {
            return Some(turn_id.to_owned());
        }
    }
    None
}

fn synthetic_transcript_turn_id_base(value: &str) -> Option<&str> {
    let (turn_id, segment) = value.rsplit_once('-')?;
    if segment.parse::<usize>().is_err() || !is_codex_thread_id(turn_id) {
        return None;
    }
    Some(turn_id)
}
