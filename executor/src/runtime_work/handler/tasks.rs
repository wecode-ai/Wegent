// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn generate_text(&self, payload: Value) -> Result<Value, AppIpcError> {
        let mut request = execution_request(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "executionRequest is required"))?;
        request.ephemeral = true;
        let turn = self
            .codex_app_server
            .run_turn_with_cancel(request, CodexAppServerTurnOptions::default())
            .await
            .map_err(|error| AppIpcError::new("model_transport_failed", error))?;
        match turn.outcome {
            ExecutionOutcome::Completed { content } => Ok(json!({"content": content})),
            ExecutionOutcome::Failed { message } => {
                Err(AppIpcError::new("model_request_failed", message))
            }
            outcome => Err(AppIpcError::new(
                "model_request_incomplete",
                format!("text generation did not complete: {outcome:?}"),
            )),
        }
    }

    pub(super) async fn generate_friendly_title(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let source_title = string_field(&payload, "sourceTitle")
            .or_else(|| string_field(&payload, "source_title"))
            .ok_or_else(|| AppIpcError::new("bad_request", "sourceTitle is required"))?;
        let link = self.task_link_from_payload(&payload, false).await?;
        if link.title != source_title {
            log_executor_event(
                "friendly task title generation skipped",
                &[
                    ("local_task_id", link.local_task_id),
                    ("reason", "title_changed_before_generation".to_owned()),
                ],
            );
            return Ok(json!({"success": true, "skipped": true}));
        }
        let local_task_id = link.local_task_id.clone();
        let mut request = execution_request(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "executionRequest is required"))?;
        request.ephemeral = true;
        let result = self
            .codex_app_server
            .run_turn_with_cancel(request.clone(), CodexAppServerTurnOptions::default())
            .await;
        let content = match result {
            Ok(turn) => match turn.outcome {
                ExecutionOutcome::Completed { content } => content,
                ExecutionOutcome::Failed { message } => {
                    log_executor_event(
                        "friendly task title generation failed",
                        &[
                            ("local_task_id", local_task_id.clone()),
                            ("reason", "model_request_failed".to_owned()),
                            ("error", message.clone()),
                        ],
                    );
                    return Ok(json!({"success": false, "error": message}));
                }
                outcome => {
                    let error = format!("friendly title generation did not complete: {outcome:?}");
                    log_executor_event(
                        "friendly task title generation failed",
                        &[
                            ("local_task_id", local_task_id.clone()),
                            ("reason", "model_request_incomplete".to_owned()),
                            ("error", error.clone()),
                        ],
                    );
                    return Ok(json!({"success": false, "error": error}));
                }
            },
            Err(error) => {
                log_executor_event(
                    "friendly task title generation failed",
                    &[
                        ("local_task_id", local_task_id.clone()),
                        ("reason", "model_transport_failed".to_owned()),
                        ("error", error.clone()),
                    ],
                );
                return Ok(json!({"success": false, "error": error}));
            }
        };
        let Some(title) = normalize_friendly_title(&content) else {
            log_executor_event(
                "friendly task title generation failed",
                &[
                    ("local_task_id", local_task_id.clone()),
                    ("reason", "empty_model_output".to_owned()),
                ],
            );
            return Ok(json!({"success": false, "error": "friendly title was empty"}));
        };
        let mut latest_link = self.task_link_from_payload(&payload, false).await?;
        for _ in 0..25 {
            if latest_link.title != source_title {
                log_executor_event(
                    "friendly task title generation skipped",
                    &[
                        ("local_task_id", local_task_id.clone()),
                        ("reason", "title_changed_during_generation".to_owned()),
                    ],
                );
                return Ok(json!({"success": true, "skipped": true}));
            }
            if latest_link.thread_id.is_some() {
                break;
            }
            sleep(Duration::from_millis(200)).await;
            latest_link = self.task_link_from_payload(&payload, false).await?;
        }
        if latest_link.title != source_title {
            log_executor_event(
                "friendly task title generation skipped",
                &[
                    ("local_task_id", local_task_id.clone()),
                    ("reason", "title_changed_before_update".to_owned()),
                ],
            );
            return Ok(json!({"success": true, "skipped": true}));
        }
        if let Some(thread_id) = latest_link.thread_id.as_deref() {
            if let Err(error) = self
                .call_codex_thread_method(
                    "thread/name/set",
                    json!({"threadId": thread_id, "name": title}),
                )
                .await
            {
                log_executor_event(
                    "friendly task title generation failed",
                    &[
                        ("local_task_id", local_task_id.clone()),
                        ("reason", "thread_name_update_failed".to_owned()),
                        ("error", error.clone()),
                    ],
                );
                return Ok(json!({"success": false, "error": error}));
            }
        }
        latest_link.title = title.clone();
        latest_link.updated_at = now_ms();
        self.upsert_local_task(latest_link);
        emit_response_event(
            &self.event_tx,
            &self.device_id,
            "runtime.task.title.updated",
            &local_task_id,
            &request,
            json!({"title": title}),
        );
        log_executor_event(
            "friendly task title generation completed",
            &[("local_task_id", local_task_id)],
        );
        Ok(json!({"success": true, "title": title}))
    }

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
        let link = forked_task_link(
            &source,
            local_task_id.clone(),
            thread_id,
            title,
            json!({
                "taskId": source.local_task_id,
                "threadId": source_thread_id,
                "lastTurnId": last_turn_id,
            }),
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
            "source": {
                "deviceId": self.device_id,
                "taskId": source.local_task_id,
                "workspacePath": source.workspace_path,
            },
            "target": {
                "deviceId": self.device_id,
                "taskId": local_task_id,
                "workspacePath": source.workspace_path,
            },
            "runtime": "codex",
        }))
    }

    pub(super) async fn create_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let runtime = string_field(&payload, "runtime").unwrap_or_else(|| "codex".to_owned());
        if !is_codex_runtime(&runtime) && !is_claude_runtime(&runtime) {
            return Err(AppIpcError::new(
                "unsupported_runtime",
                format!("unsupported runtime: {runtime}"),
            ));
        }
        let runtime = if is_claude_runtime(&runtime) {
            "claude_code".to_owned()
        } else {
            "codex".to_owned()
        };
        let local_task_id = id_field(&payload, "taskId")
            .or_else(|| id_field(&payload, "task_id"))
            .unwrap_or_else(|| format!("{runtime}-local-{}", now_ms()));
        let payload_workspace_path = workspace_path(&payload);
        let title = string_field(&payload, "title")
            .or_else(|| string_field(&payload, "message"))
            .unwrap_or_else(|| local_task_id.clone());
        let mut request = execution_request(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "executionRequest is required"))?;
        apply_runtime_payload_metadata(&mut request, &payload);
        set_runtime_task_title(&mut request, &title);
        if is_codex_runtime(&runtime) {
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
                        None,
                    )
                    .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
                }
            }
        }
        let payload_has_workspace_path = payload_workspace_path.is_some();
        let workspace_source_task = payload
            .get("workspaceSourceTask")
            .or_else(|| payload.get("workspace_source_task"))
            .and_then(Value::as_object);
        let inherited_workspace_path = if let Some(source) = workspace_source_task {
            let source_device_id = source
                .get("deviceId")
                .or_else(|| source.get("device_id"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppIpcError::new("bad_request", "workspace source device is required")
                })?;
            let source_task_id = source
                .get("taskId")
                .or_else(|| source.get("task_id"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppIpcError::new("bad_request", "workspace source task is required")
                })?;
            if source_device_id != self.device_id {
                return Err(AppIpcError::new(
                    "workspace_source_unavailable",
                    "inherited workflow workspace belongs to another device",
                ));
            }
            Some(
                self.local_task_link(source_task_id)
                    .ok_or_else(|| {
                        AppIpcError::new(
                            "workspace_source_unavailable",
                            "inherited workflow workspace is unavailable",
                        )
                    })?
                    .workspace_path,
            )
        } else {
            None
        };
        let source_workspace_path = payload_workspace_path
            .or(inherited_workspace_path)
            .or_else(|| request.cwd().map(str::to_owned))
            .or_else(|| {
                id_field(&payload, "local_project_id")
                    .and_then(|value| value.parse::<u64>().ok())
                    .and_then(|project_id| {
                        CodexGlobalProjectIndex::load()
                            .project_for_ui_id(&self.device_id, project_id)
                            .map(|project| project.workspace_path.clone())
                    })
            })
            .or_else(|| standalone_chat_workspace_path(&local_task_id, &request))
            .ok_or_else(|| {
                log_executor_event(
                    "runtime task create missing workspace path",
                    &[
                        ("task_id", local_task_id.clone()),
                        (
                            "payload_has_workspace_path",
                            payload_has_workspace_path.to_string(),
                        ),
                        ("request_cwd", request.cwd().unwrap_or_default().to_owned()),
                        (
                            "standalone_chat_workspace",
                            is_standalone_chat_workspace(&request).to_string(),
                        ),
                        (
                            "request_extra_keys",
                            format!("{:?}", request.extra.keys().collect::<Vec<_>>()),
                        ),
                    ],
                );
                AppIpcError::new("bad_request", "workspacePath is required")
            })?;
        let workspace_path = if request.workspace_source.as_deref() == Some("git_worktree") {
            let git_ref = payload
                .get("execution")
                .and_then(|execution| execution.get("workspace"))
                .and_then(|workspace| workspace.get("branch"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|branch| !branch.is_empty())
                .map(ToOwned::to_owned);
            let worktrees = self.worktrees.clone();
            let plan_source_path = PathBuf::from(&source_workspace_path);
            let plan_worktree_id = local_task_id.clone();
            let plan_git_ref = git_ref.clone();
            let plan = tokio::task::spawn_blocking(move || {
                worktrees.plan(
                    &plan_source_path,
                    &plan_worktree_id,
                    plan_git_ref.as_deref(),
                )
            })
            .await
            .map_err(|error| {
                AppIpcError::new(
                    "worktree_prepare_failed",
                    format!("Worktree planning task failed: {error}"),
                )
            })?
            .map_err(|error| AppIpcError::new(worktree_error_code(&error), error))?;
            request.extra.insert(
                "deferred_worktree_source_path".to_owned(),
                Value::String(plan.source_path.display().to_string()),
            );
            request.extra.insert(
                "deferred_worktree_path".to_owned(),
                Value::String(plan.path.display().to_string()),
            );
            request.extra.insert(
                "deferred_worktree_repo_root_fingerprint".to_owned(),
                Value::String(plan.repo_root_fingerprint),
            );
            if let Some(branch) = git_ref {
                request
                    .extra
                    .insert("deferred_worktree_ref".to_owned(), Value::String(branch));
            }
            plan.path.display().to_string()
        } else {
            source_workspace_path
        };
        if request.project_workspace_path.as_deref() != Some(workspace_path.as_str()) {
            request.project_workspace_path = Some(workspace_path.clone());
        }
        self.apply_project_workspace_roots(&mut request);

        let mut link = RuntimeTaskLink::new_pending_with_runtime(
            local_task_id.clone(),
            workspace_path.clone(),
            title.clone(),
            runtime.clone(),
        );
        link.ephemeral = request.ephemeral || bool_field(&payload, "ephemeral").unwrap_or(false);
        link.runtime_project_key = request.runtime_project_key.clone();
        link.runtime_workspace_roots = request.runtime_workspace_roots.clone();
        link.project_instructions = request.system_prompt.clone();
        link.project_plugin_ids = project_plugin_ids(&request);
        set_runtime_handle_model_selection(&mut link.runtime_handle, &payload);
        if let Some(executable_path) = request
            .extra
            .get("runtime_executable_path")
            .or_else(|| request.extra.get("runtimeExecutablePath"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
        {
            if let Some(runtime_handle) = link.runtime_handle.as_object_mut() {
                runtime_handle.insert(
                    "runtimeExecutablePath".to_owned(),
                    Value::String(executable_path),
                );
            }
        }
        if let Some(permission_mode) = request
            .extra
            .get("claude_permission_mode")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
        {
            if let Some(runtime_handle) = link.runtime_handle.as_object_mut() {
                runtime_handle.insert(
                    "claudePermissionMode".to_owned(),
                    Value::String(permission_mode),
                );
            }
        }
        if let (Some(runtime_handle), Some(project_id)) = (
            link.runtime_handle.as_object_mut(),
            cloud_project_id(&request),
        ) {
            runtime_handle.insert("cloudProjectId".to_owned(), project_id);
        }
        if let (Some(runtime_handle), Some(origin)) = (
            link.runtime_handle.as_object_mut(),
            payload.get("origin").filter(|value| value.is_object()),
        ) {
            runtime_handle.insert("origin".to_owned(), origin.clone());
        }
        if let Some(message) = cached_user_message(&local_task_id, &request, &payload) {
            set_runtime_handle_messages(&mut link.runtime_handle, vec![message]);
        }
        if let Some(presentation) = user_message_presentation(&payload) {
            append_runtime_handle_user_message_presentation(&mut link.runtime_handle, presentation);
        }
        if is_codex_runtime(&runtime) {
            if let Some(supervisor) = payload
                .get("initialSupervisor")
                .or_else(|| payload.get("initial_supervisor"))
            {
                let configured = super::supervisor::configured_supervisor(supervisor, None)?;
                self.configure_supervisor_model(&local_task_id, &configured, supervisor)?;
                link.supervisor = Some(configured);
            }
        }
        let mut runtime_handle = runtime_handle_json(&link);
        self.upsert_local_task(link);
        self.schedule_worktree_prune();
        if is_claude_runtime(&runtime) {
            self.prepare_claude_goal(&local_task_id, &mut request, &payload);
            if let Err(error) = self.spawn_claude_turn(local_task_id.clone(), request).await {
                self.retain_failed_runtime_task(&local_task_id, &error);
                return Err(error);
            }
        } else {
            let initial_thread_goal = initial_thread_goal_from_payload(&payload);
            let mut side_source = side_source_thread(&payload);
            if let Some(source) = &mut side_source {
                if source.thread_path.is_none() {
                    source.thread_path = self.thread_path_for_id(&source.thread_id).await;
                }
            }
            if let Err(error) = self
                .spawn_turn(SpawnTurnRequest {
                    local_task_id: local_task_id.clone(),
                    runtime: "codex".to_owned(),
                    request,
                    direct_thread_id: None,
                    fork_thread_id: side_source.as_ref().map(|source| source.thread_id.clone()),
                    fork_thread_path: side_source.and_then(|source| source.thread_path),
                    resume_thread_id: None,
                    initial_thread_goal,
                })
                .await
            {
                self.retain_failed_runtime_task(&local_task_id, &error);
                self.supervisor_model_configs
                    .lock()
                    .expect("supervisor model config map lock should not be poisoned")
                    .remove(&local_task_id);
                return Err(error);
            }
        }
        let queue_position = self
            .queued_local_task_position(&local_task_id)
            .map(|position| position + 1);
        if let (Some(queue_position), Some(runtime_handle)) =
            (queue_position, runtime_handle.as_object_mut())
        {
            runtime_handle.insert("queuePosition".to_owned(), json!(queue_position));
        }
        match payload
            .get("friendlyTitleExecutionRequest")
            .cloned()
            .filter(|_| is_codex_runtime(&runtime))
        {
            Some(value) => match serde_json::from_value::<ExecutionRequest>(value) {
                Ok(execution_request) => {
                    log_executor_event(
                        "friendly task title generation queued",
                        &[("local_task_id", local_task_id.clone())],
                    );
                    let handler = self.clone();
                    let friendly_payload = json!({
                        "taskId": local_task_id,
                        "sourceTitle": title,
                        "executionRequest": execution_request,
                    });
                    tokio::spawn(async move {
                        if let Err(error) = handler.generate_friendly_title(friendly_payload).await
                        {
                            log_executor_event(
                                "friendly task title generation failed",
                                &[("error", error.message)],
                            );
                        }
                    });
                }
                Err(error) => log_executor_event(
                    "friendly task title generation rejected",
                    &[
                        ("local_task_id", local_task_id.clone()),
                        ("reason", "invalid_execution_request".to_owned()),
                        ("error", error.to_string()),
                    ],
                ),
            },
            None => log_executor_event(
                "friendly task title generation skipped",
                &[
                    ("local_task_id", local_task_id.clone()),
                    ("reason", "missing_execution_request".to_owned()),
                ],
            ),
        }

        Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": self.device_id,
            "taskId": local_task_id,
            "workspacePath": workspace_path,
            "runtime": runtime,
            "runtimeHandle": runtime_handle,
            "status": if queue_position.is_some() { "queued" } else { "running" },
            "queuePosition": queue_position,
        }))
    }

    fn retain_failed_runtime_task(&self, local_task_id: &str, error: &AppIpcError) {
        self.store.update_task(local_task_id, |link| {
            apply_runtime_task_start_failure(link, error);
        });
    }

    pub(super) fn record_runtime_turn_id(
        &self,
        local_task_id: &str,
        subtask_id: &str,
        turn_id: &str,
        client_user_message_id: Option<&str>,
    ) {
        self.store.update_task(local_task_id, |link| {
            if !link.runtime_handle.is_object() {
                link.runtime_handle = json!({});
            }
            if let Some(runtime_handle) = link.runtime_handle.as_object_mut() {
                runtime_handle.insert("lastTurnId".to_owned(), Value::String(turn_id.to_owned()));
                let mappings = runtime_handle
                    .entry("turnIdsBySubtask")
                    .or_insert_with(|| json!({}));
                if let Some(mappings) = mappings.as_object_mut() {
                    mappings.insert(subtask_id.to_owned(), Value::String(turn_id.to_owned()));
                }
            }
            if let Some(client_user_message_id) = client_user_message_id {
                bind_runtime_handle_user_message_presentation_to_turn(
                    &mut link.runtime_handle,
                    client_user_message_id,
                    turn_id,
                );
            }
        });
    }

    pub(super) fn record_superseded_runtime_transcript_turn(
        &self,
        local_task_id: &str,
        turn_id: &str,
    ) {
        self.store.update_task(local_task_id, |link| {
            let Some(runtime_handle) = link.runtime_handle.as_object_mut() else {
                link.runtime_handle = json!({
                    "supersededTranscriptTurnIds": [turn_id],
                });
                return;
            };
            let turn_ids = runtime_handle
                .entry("supersededTranscriptTurnIds")
                .or_insert_with(|| json!([]));
            let Some(turn_ids) = turn_ids.as_array_mut() else {
                *turn_ids = json!([turn_id]);
                return;
            };
            if !turn_ids
                .iter()
                .any(|existing| existing.as_str() == Some(turn_id))
            {
                turn_ids.push(Value::String(turn_id.to_owned()));
            }
        });
    }

    pub(super) async fn send_message(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let gate = self.task_send_gate(&local_task_id);
        let _guard = gate.lock().await;
        self.send_message_after_local_checks(payload).await
    }

    async fn send_message_after_local_checks(&self, payload: Value) -> Result<Value, AppIpcError> {
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
        if self.is_busy_local_task(&local_task_id) {
            return Ok(json!({
                "success": false,
                "error": "runtime task is already running",
                "code": "bad_request",
            }));
        }
        let workspace_path = existing_link
            .as_ref()
            .map(|link| link.workspace_path.clone())
            .filter(|path| !path.trim().is_empty())
            .or_else(|| workspace_path(&payload))
            .unwrap_or_default();
        let worktrees = self.worktrees.clone();
        let restore_path = PathBuf::from(&workspace_path);
        let restore_result =
            tokio::task::spawn_blocking(move || worktrees.restore_if_known(&restore_path))
                .await
                .map_err(|error| {
                    AppIpcError::new(
                        "worktree_restore_required",
                        format!("Worktree restore task failed: {error}"),
                    )
                })?;
        if let Err(error) = restore_result {
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
            set_runtime_task_title(&mut request, &link.title);
        }
        if let Some(link) = existing_link.as_ref() {
            mark_runtime_model_switch(&mut request, link, &payload);
        }
        if let Some(link) = existing_link.as_ref() {
            restore_cloud_project_id(&mut request, &link.runtime_handle);
            restore_origin(&mut request, &link.runtime_handle);
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
        if request.system_prompt.trim().is_empty() {
            request.system_prompt = existing_link
                .as_ref()
                .map(|link| link.project_instructions.clone())
                .unwrap_or_default();
        }
        if project_plugin_ids(&request).is_empty() {
            if let Some(plugin_ids) = existing_link
                .as_ref()
                .map(|link| link.project_plugin_ids.clone())
                .filter(|plugin_ids| !plugin_ids.is_empty())
            {
                request
                    .extra
                    .insert("project_plugin_ids".to_owned(), json!(plugin_ids));
            }
        }
        if !workspace_path.is_empty() {
            request.project_workspace_path = Some(workspace_path.clone());
        }
        self.apply_project_workspace_roots(&mut request);
        let runtime = existing_link
            .as_ref()
            .map(|link| link.runtime.clone())
            .or_else(|| string_field(&payload, "runtime"))
            .unwrap_or_else(|| "codex".to_owned());
        if is_claude_runtime(&runtime) {
            if request.extra.get("runtime_executable_path").is_none() {
                if let Some(executable_path) = existing_link
                    .as_ref()
                    .and_then(|link| string_field(&link.runtime_handle, "runtimeExecutablePath"))
                {
                    request.extra.insert(
                        "runtime_executable_path".to_owned(),
                        Value::String(executable_path),
                    );
                }
            }
            if request.extra.get("claude_permission_mode").is_none() {
                if let Some(permission_mode) = existing_link
                    .as_ref()
                    .and_then(|link| string_field(&link.runtime_handle, "claudePermissionMode"))
                {
                    request.extra.insert(
                        "claude_permission_mode".to_owned(),
                        Value::String(permission_mode),
                    );
                }
            }
            self.prepare_claude_goal(&local_task_id, &mut request, &payload);
            self.prepare_claude_send(&local_task_id, &workspace_path, &request, &payload);
            self.spawn_claude_turn(local_task_id.clone(), request)
                .await?;
            let queue_position = self
                .queued_local_task_position(&local_task_id)
                .map(|position| position + 1);
            return Ok(json!({
                "success": true,
                "accepted": true,
                "deviceId": self.device_id,
                "taskId": local_task_id,
                "runtime": "claude_code",
                "status": if queue_position.is_some() { "queued" } else { "running" },
                "queuePosition": queue_position,
            }));
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
        let link_for_send = existing_link.as_ref().or(recovered_link.as_ref());
        let ephemeral = request.ephemeral || link_for_send.is_some_and(|link| link.ephemeral);

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
        if let Some(turn_id) = retry_source_turn_id(&payload) {
            self.record_superseded_runtime_transcript_turn(&local_task_id, &turn_id);
        }
        self.schedule_worktree_prune();
        let direct_thread_id = ephemeral.then(|| thread_id.clone());
        let resume_thread_id = (!ephemeral).then_some(thread_id);
        let initial_thread_goal = initial_thread_goal_from_payload(&payload);

        self.spawn_turn(SpawnTurnRequest {
            local_task_id: local_task_id.clone(),
            runtime: "codex".to_owned(),
            request,
            direct_thread_id,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id,
            initial_thread_goal,
        })
        .await?;
        let queue_position = self
            .queued_local_task_position(&local_task_id)
            .map(|position| position + 1);

        Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": self.device_id,
            "taskId": local_task_id,
            "runtime": "codex",
            "status": if queue_position.is_some() { "queued" } else { "running" },
            "queuePosition": queue_position,
        }))
    }

    pub(super) async fn interrupt_and_send(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let gate = self.task_send_gate(&local_task_id);
        let _guard = gate.lock().await;
        let check_provider_turn = !bool_field(&payload, "ephemeral").unwrap_or(false)
            && !self
                .local_task_link(&local_task_id)
                .is_some_and(|link| link.ephemeral);
        let thread_id = if check_provider_turn {
            runtime_session_id_from_payload(&payload).or_else(|| {
                self.local_task_link(&local_task_id)
                    .as_ref()
                    .and_then(runtime_session_id_from_link)
            })
        } else {
            None
        };
        let had_active_local_execution = self.is_active_local_task(&local_task_id);
        self.resolve_pending_request_user_input_for_stop(&local_task_id);
        if let Some(thread_id) = thread_id.as_deref() {
            if self
                .settle_local_execution_from_terminal_codex_turn(
                    &local_task_id,
                    thread_id,
                    "interrupt_and_send_provider_terminal",
                    PROVIDER_STATE_RECONCILIATION_TIMEOUT,
                )
                .await
            {
                return self.send_message_after_local_checks(payload).await;
            }
        }
        let local_stop = self.abort_active_turn(&local_task_id);
        let provider_stop = async {
            match (had_active_local_execution, thread_id.as_deref()) {
                (false, Some(thread_id)) => tokio::time::timeout(
                    Duration::from_secs(10),
                    self.interrupt_provider_active_turn(thread_id),
                )
                .await
                .unwrap_or(false),
                _ => true,
            }
        };
        let (local_stopped, provider_stopped) = tokio::join!(local_stop, provider_stop);
        if !local_stopped {
            self.force_settle_local_task_execution(
                &local_task_id,
                thread_id,
                "cancelled",
                "interrupt_and_send_timeout",
            );
        }
        if !provider_stopped {
            log_executor_event(
                "runtime work provider interrupt cleanup pending",
                &[("local_task_id", local_task_id.clone())],
            );
        }
        self.send_message_after_local_checks(payload).await
    }

    async fn settle_local_execution_from_terminal_codex_turn(
        &self,
        local_task_id: &str,
        thread_id: &str,
        reason: &str,
        timeout: Duration,
    ) -> bool {
        let thread =
            match tokio::time::timeout(timeout, self.read_codex_recent_turns(thread_id)).await {
                Ok(Ok(thread)) => thread,
                Ok(Err(error)) => {
                    log_executor_event(
                        "runtime work provider state read failed during reconciliation",
                        &[
                            ("local_task_id", local_task_id.to_owned()),
                            ("thread_id", thread_id.to_owned()),
                            ("error", error),
                        ],
                    );
                    return false;
                }
                Err(_) => {
                    log_executor_event(
                        "runtime work provider state read timed out during reconciliation",
                        &[
                            ("local_task_id", local_task_id.to_owned()),
                            ("thread_id", thread_id.to_owned()),
                        ],
                    );
                    return false;
                }
            };
        let Some(status) = codex_thread_terminal_task_status(&thread) else {
            return false;
        };
        self.force_settle_local_task_execution(
            local_task_id,
            Some(thread_id.to_owned()),
            status,
            reason,
        )
    }

    async fn interrupt_provider_active_turn(&self, thread_id: &str) -> bool {
        let thread = match self.read_codex_recent_turns(thread_id).await {
            Ok(thread) => thread,
            Err(error) => {
                log_executor_event(
                    "runtime work provider turn read failed before interrupt",
                    &[("thread_id", thread_id.to_owned()), ("error", error)],
                );
                return false;
            }
        };
        let Some(turn_id) = codex_thread_in_progress_turn_id(&thread) else {
            return !codex_thread_has_in_progress_turn(&thread);
        };
        if let Err(error) = self
            .codex_app_server
            .request(
                "turn/interrupt",
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                }),
            )
            .await
        {
            log_executor_event(
                "runtime work provider turn interrupt failed",
                &[
                    ("thread_id", thread_id.to_owned()),
                    ("turn_id", turn_id),
                    ("error", error),
                ],
            );
            return false;
        }
        for _ in 0..PROVIDER_TURN_INTERRUPT_WAIT_ATTEMPTS {
            match self.read_codex_recent_turns(thread_id).await {
                Ok(thread) if !codex_thread_has_in_progress_turn(&thread) => return true,
                Ok(_) => {
                    sleep(Duration::from_millis(PROVIDER_TURN_INTERRUPT_WAIT_MS)).await;
                }
                Err(error) => {
                    log_executor_event(
                        "runtime work provider turn read failed after interrupt",
                        &[("thread_id", thread_id.to_owned()), ("error", error)],
                    );
                    return false;
                }
            }
        }
        false
    }

    pub(super) async fn rollback_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let requested_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let existing_link = self.task_link_from_payload(&payload, false).await?;
        let local_task_id = existing_link.local_task_id.clone();
        if self.is_busy_local_task(&existing_link.local_task_id) {
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
        let workspace_path = (!existing_link.workspace_path.trim().is_empty())
            .then(|| existing_link.workspace_path.clone())
            .or_else(|| workspace_path(&payload))
            .unwrap_or_default();
        apply_runtime_payload_metadata(&mut request, &payload);
        set_runtime_task_title(&mut request, &existing_link.title);
        mark_runtime_model_switch(&mut request, &existing_link, &payload);
        restore_cloud_project_id(&mut request, &existing_link.runtime_handle);
        restore_origin(&mut request, &existing_link.runtime_handle);
        request.new_session = false;
        if !workspace_path.is_empty() {
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
        log_executor_event("runtime work message edit prepared", &fields);

        self.mark_task_running_for_send(
            &local_task_id,
            &thread_id,
            &workspace_path,
            &request,
            &payload,
        );
        if let Some(turn_id) = retry_source_turn_id(&payload) {
            self.record_superseded_runtime_transcript_turn(&local_task_id, &turn_id);
        }
        self.spawn_turn(SpawnTurnRequest {
            local_task_id: local_task_id.clone(),
            runtime: "codex".to_owned(),
            request,
            direct_thread_id: None,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: Some(thread_id),
            initial_thread_goal: None,
        })
        .await?;

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
        let previous_turn_id = match self.read_codex_recent_turns(&thread_id).await {
            Ok(thread) => latest_codex_turn_id(&thread),
            Err(error) => return Ok(task_action_failure(&link, error)),
        };
        match self
            .call_codex_thread_method(
                "thread/compact/start",
                json!({"threadId": thread_id.clone()}),
            )
            .await
        {
            Ok(_) => {
                let (turn_id, item_id) = match self
                    .wait_for_context_compaction(&thread_id, previous_turn_id.as_deref())
                    .await
                {
                    Ok(completion) => completion,
                    Err(error) => return Ok(task_action_failure(&link, error)),
                };
                self.store.update_task(&local_task_id, |stored| {
                    stored.updated_at = now_ms();
                });
                let mut response = task_action_success(&link);
                if let Some(response) = response.as_object_mut() {
                    response.insert("turnId".to_owned(), Value::String(turn_id));
                    response.insert("compactionItemId".to_owned(), Value::String(item_id));
                }
                Ok(response)
            }
            Err(error) => Ok(task_action_failure(&link, error)),
        }
    }

    async fn wait_for_context_compaction(
        &self,
        thread_id: &str,
        previous_turn_id: Option<&str>,
    ) -> Result<(String, String), String> {
        let mut last_error = None;
        for _ in 0..CONTEXT_COMPACTION_WAIT_ATTEMPTS {
            match self.read_codex_recent_turns(thread_id).await {
                Ok(thread) => {
                    if let Some(completion) =
                        completed_context_compaction(&thread, previous_turn_id)
                    {
                        return Ok(completion);
                    }
                }
                Err(error) => last_error = Some(error),
            }
            sleep(Duration::from_millis(CONTEXT_COMPACTION_WAIT_MS)).await;
        }
        Err(last_error.unwrap_or_else(|| "context compaction timed out".to_owned()))
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
            codex_runtime_approval_policy(&runtime_event_request_from_link(link)),
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
        self.cancel_task_with_timeout(payload, Duration::from_secs(10))
            .await
    }

    pub(super) async fn cancel_task_with_timeout(
        &self,
        payload: Value,
        stop_timeout: Duration,
    ) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let link = self
            .store
            .update_task(&local_task_id, |link| {
                link.updated_at = now_ms();
                link.completed_at = Some(link.updated_at);
            })
            .or_else(|| self.local_task_link(&local_task_id));
        let thread_id = link.as_ref().and_then(runtime_session_id_from_link);
        let is_codex = link
            .as_ref()
            .map_or(true, |link| link.runtime.eq_ignore_ascii_case("codex"));
        let had_active_local_execution = self.is_active_local_task(&local_task_id);
        self.resolve_pending_request_user_input_for_stop(&local_task_id);
        if self.remove_queued_turn(&local_task_id).await? {
            return Ok(match link {
                Some(link) => task_action_success(&link),
                None => json!({
                    "success": true,
                    "accepted": true,
                    "taskId": local_task_id,
                    "runtime": "codex",
                }),
            });
        }
        if self.cancel_preparing_worktree_turn(&local_task_id) {
            return Ok(match link {
                Some(link) => task_action_success(&link),
                None => json!({
                    "success": true,
                    "accepted": true,
                    "taskId": local_task_id,
                    "runtime": "codex",
                }),
            });
        }
        if is_codex {
            if let Some(thread_id) = thread_id.as_deref() {
                if self
                    .settle_local_execution_from_terminal_codex_turn(
                        &local_task_id,
                        thread_id,
                        "cancel_provider_terminal",
                        PROVIDER_STATE_RECONCILIATION_TIMEOUT.min(stop_timeout),
                    )
                    .await
                {
                    return Ok(match self.local_task_link(&local_task_id).or(link) {
                        Some(link) => task_action_success(&link),
                        None => json!({
                            "success": true,
                            "accepted": true,
                            "taskId": local_task_id,
                            "runtime": "codex",
                        }),
                    });
                }
            }
        }
        let local_stop = self.abort_active_turn_with_timeout(&local_task_id, stop_timeout);
        let provider_stop = async {
            match (is_codex, had_active_local_execution, thread_id.as_deref()) {
                (true, false, Some(thread_id)) => tokio::time::timeout(
                    stop_timeout,
                    self.interrupt_provider_active_turn(thread_id),
                )
                .await
                .unwrap_or(false),
                _ => true,
            }
        };
        let (local_stopped, provider_stopped) = tokio::join!(local_stop, provider_stop);
        if !local_stopped {
            self.force_settle_local_task_execution(
                &local_task_id,
                thread_id,
                "cancelled",
                "cancel_timeout",
            );
        }
        let cleanup_pending = !local_stopped || !provider_stopped;

        Ok(match self.local_task_link(&local_task_id).or(link) {
            Some(link) => {
                let mut response = task_action_success(&link);
                response["cleanupPending"] = Value::Bool(cleanup_pending);
                response
            }
            None => json!({
                "success": true,
                "accepted": true,
                "taskId": local_task_id,
                "runtime": "codex",
                "cleanupPending": cleanup_pending,
            }),
        })
    }

    pub(super) async fn force_start_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let runtime = self
            .store
            .get_task(&local_task_id)
            .map(|link| link.runtime)
            .unwrap_or_else(|| "codex".to_owned());
        let _operation = self.turn_queue_operation.lock().await;
        let (previous, queued_turn, remaining_turns) = {
            let mut scheduler = self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned");
            if scheduler.queued_position(&local_task_id).is_none() {
                return Ok(json!({
                    "success": false,
                    "accepted": false,
                    "taskId": local_task_id,
                    "runtime": runtime,
                    "error": "runtime task is not queued",
                    "code": "not_queued",
                }));
            }
            let previous = scheduler.clone();
            let turn = scheduler.force_start(&local_task_id).ok_or_else(|| {
                AppIpcError::new("runtime_queue_failed", "queued runtime task disappeared")
            })?;
            (previous, turn, scheduler.queued_turns.clone())
        };
        if let Err(error) = self.persist_turn_queue(remaining_turns).await {
            *self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned") = previous;
            return Err(error);
        }
        self.reserve_worktree_preparation(&queued_turn);
        drop(_operation);
        log_executor_event(
            "runtime work queued turn force started",
            &[("local_task_id", local_task_id.clone())],
        );
        if queued_turn
            .request
            .extra
            .contains_key("deferred_worktree_source_path")
        {
            self.prepare_and_start_reserved_turn(queued_turn).await?;
        } else {
            self.start_turn(queued_turn);
        }
        Ok(json!({
            "success": true,
            "accepted": true,
            "started": true,
            "queued": false,
            "taskId": local_task_id,
            "runtime": runtime,
        }))
    }

    pub(super) async fn reorder_queued_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let local_task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let runtime = self
            .store
            .get_task(&local_task_id)
            .map(|link| link.runtime)
            .unwrap_or_else(|| "codex".to_owned());
        let target_position = integer_field(&payload, "queuePosition")
            .or_else(|| integer_field(&payload, "queue_position"))
            .ok_or_else(|| AppIpcError::new("bad_request", "queuePosition is required"))?;
        if target_position < 1 {
            return Err(AppIpcError::new(
                "bad_request",
                "queuePosition must be at least 1",
            ));
        }
        let _operation = self.turn_queue_operation.lock().await;
        let (previous, ordered_task_ids, reordered) = {
            let mut scheduler = self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned");
            if scheduler.queued_position(&local_task_id).is_none() {
                return Ok(json!({
                    "success": false,
                    "accepted": false,
                    "taskId": local_task_id,
                    "runtime": runtime,
                    "error": "runtime task is not queued",
                    "code": "not_queued",
                }));
            }
            let reordered = scheduler
                .reordered_queue(&local_task_id, target_position as usize)
                .map_err(|error| AppIpcError::new("runtime_queue_failed", error))?;
            let previous = scheduler.clone();
            scheduler.queued_turns = reordered.clone();
            let ordered_task_ids = scheduler
                .queued_turns
                .iter()
                .map(|turn| turn.local_task_id.clone())
                .collect::<Vec<_>>();
            (previous, ordered_task_ids, reordered)
        };
        if let Err(error) = self.persist_turn_queue(reordered).await {
            *self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned") = previous;
            return Err(error);
        }
        log_executor_event(
            "runtime work queued turn reordered",
            &[
                ("local_task_id", local_task_id.clone()),
                ("queue_position", target_position.to_string()),
            ],
        );
        Ok(json!({
            "success": true,
            "accepted": true,
            "taskId": local_task_id,
            "runtime": runtime,
            "orderedTaskIds": ordered_task_ids,
        }))
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
            if link.thread_id.as_deref() != Some(thread_id) {
                clear_completed_transcript_messages(&mut link.runtime_handle);
                clear_transcript_snapshot_messages(&mut link.runtime_handle);
            }
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
            if !request.system_prompt.trim().is_empty() {
                link.project_instructions = request.system_prompt.clone();
            }
            let plugin_ids = project_plugin_ids(request);
            if !plugin_ids.is_empty() {
                link.project_plugin_ids = plugin_ids;
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
        link.project_instructions = request.system_prompt.clone();
        link.project_plugin_ids = project_plugin_ids(request);
        set_runtime_handle_model_selection(&mut link.runtime_handle, payload);
        if let Some(presentation) = presentation {
            append_runtime_handle_user_message_presentation(&mut link.runtime_handle, presentation);
        }
        self.upsert_local_task(link);
    }
}

pub(super) fn forked_task_link(
    source: &RuntimeTaskLink,
    local_task_id: String,
    thread_id: String,
    title: String,
    parent: Value,
) -> RuntimeTaskLink {
    let mut link = RuntimeTaskLink::new_pending_with_runtime(
        local_task_id,
        source.workspace_path.clone(),
        title,
        source.runtime.clone(),
    );
    link.thread_id = Some(thread_id);
    link.parent = Some(parent);
    link.runtime_project_key = source.runtime_project_key.clone();
    link.runtime_workspace_roots = source.runtime_workspace_roots.clone();
    link.project_instructions = source.project_instructions.clone();
    link.project_plugin_ids = source.project_plugin_ids.clone();
    link
}

fn project_plugin_ids(request: &ExecutionRequest) -> Vec<String> {
    request
        .extra
        .get("project_plugin_ids")
        .or_else(|| request.extra.get("projectPluginIds"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn apply_runtime_task_start_failure(link: &mut RuntimeTaskLink, error: &AppIpcError) {
    link.running = false;
    link.status = "failed".to_owned();
    link.thread_status = "failed".to_owned();
    link.turn_status = Some("failed".to_owned());
    link.updated_at = now_ms();
    link.completed_at = Some(link.updated_at);
    normalize_settled_task_state(link);
    if !link.runtime_handle.is_object() {
        link.runtime_handle = json!({});
    }
    if let Some(runtime_handle) = link.runtime_handle.as_object_mut() {
        runtime_handle.remove("queuePosition");
        runtime_handle.insert("lastError".to_owned(), Value::String(error.message.clone()));
        runtime_handle.insert(
            "lastErrorCode".to_owned(),
            Value::String(error.code.clone()),
        );
    }
}

fn normalize_friendly_title(value: &str) -> Option<String> {
    let title = value
        .lines()
        .find_map(|line| {
            let trimmed = line
                .trim()
                .trim_matches(|ch| matches!(ch, '"' | '\'' | '“' | '”' | '‘' | '’' | '`'));
            (!trimmed.is_empty()).then_some(trimmed)
        })?
        .chars()
        .take(48)
        .collect::<String>()
        .trim()
        .trim_end_matches(['。', '！', '？', '.', '!', '?'])
        .trim()
        .to_owned();
    (!title.is_empty()).then_some(title)
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

fn retry_source_turn_id(payload: &Value) -> Option<String> {
    string_field(payload, "retrySourceTurnId")
        .or_else(|| string_field(payload, "retry_source_turn_id"))
        .filter(|turn_id| !turn_id.trim().is_empty())
}

fn latest_codex_turn_id(thread: &Value) -> Option<String> {
    thread
        .get("turns")
        .and_then(Value::as_array)
        .and_then(|turns| turns.last())
        .and_then(|turn| string_field(turn, "id"))
}

fn completed_context_compaction(
    thread: &Value,
    previous_turn_id: Option<&str>,
) -> Option<(String, String)> {
    thread
        .get("turns")
        .and_then(Value::as_array)?
        .iter()
        .rev()
        .filter_map(|turn| Some((turn, string_field(turn, "id")?)))
        .filter(|(_, turn_id)| Some(turn_id.as_str()) != previous_turn_id)
        .find_map(|(turn, turn_id)| {
            turn.get("items")
                .and_then(Value::as_array)?
                .iter()
                .find(|item| is_codex_context_compaction_item_type(&item_type(item)))
                .map(|item| (turn_id, item_id(item, "context_compaction")))
        })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::{local::app_ipc::AppIpcError, runtime_work::response::RuntimeTaskLink};

    use super::{
        apply_runtime_task_start_failure, completed_context_compaction, normalize_friendly_title,
    };

    #[test]
    fn normalizes_model_title_to_one_short_line() {
        assert_eq!(
            normalize_friendly_title("  “为任务创建友好标题。”\n这是解释"),
            Some("为任务创建友好标题".to_owned())
        );
    }

    #[test]
    fn rejects_empty_model_title() {
        assert_eq!(normalize_friendly_title(" \n\t "), None);
    }

    #[test]
    fn finds_a_new_completed_context_compaction() {
        let thread = json!({
            "turns": [
                {
                    "id": "turn-before",
                    "items": [{"id": "message-1", "type": "agentMessage"}]
                },
                {
                    "id": "turn-compact",
                    "items": [{"id": "compact-1", "type": "contextCompaction"}]
                }
            ]
        });

        assert_eq!(
            completed_context_compaction(&thread, Some("turn-before")),
            Some(("turn-compact".to_owned(), "compact-1".to_owned()))
        );
        assert_eq!(
            completed_context_compaction(&thread, Some("turn-compact")),
            None
        );
    }

    #[test]
    fn failed_runtime_start_keeps_a_diagnosable_task_link() {
        let mut link = RuntimeTaskLink::new_pending(
            "task-1".to_owned(),
            "/workspace/repository".to_owned(),
            "Task".to_owned(),
        );
        link.runtime_handle = json!({"queuePosition": 1});
        let error = AppIpcError::new(
            "worktree_source_changed",
            "Source repository identity changed after planning",
        );

        apply_runtime_task_start_failure(&mut link, &error);

        assert!(!link.running);
        assert_eq!(link.status, "failed");
        assert_eq!(link.thread_status, "failed");
        assert_eq!(link.turn_status.as_deref(), Some("failed"));
        assert!(link.completed_at.is_some());
        assert_eq!(
            link.runtime_handle["lastError"],
            "Source repository identity changed after planning"
        );
        assert_eq!(
            link.runtime_handle["lastErrorCode"],
            "worktree_source_changed"
        );
        assert!(link.runtime_handle.get("queuePosition").is_none());
    }
}
