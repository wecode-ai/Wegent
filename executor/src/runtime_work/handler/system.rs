// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::codex_config::optional_proxy_url;
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn spawn_startup_worktree_reconciliation(&self) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let handler = self.clone();
        runtime.spawn(async move {
            if handler.reconcile_worktrees_once().await {
                handler.resume_persisted_turns().await;
            }
        });
    }

    pub(super) async fn reconcile_worktrees_once(&self) -> bool {
        let mut reconciliation = self.worktree_reconciliation_state.lock().await;
        if reconciliation.completed {
            return true;
        }
        let now = Instant::now();
        if reconciliation.last_attempt.is_some_and(|last_attempt| {
            now.saturating_duration_since(last_attempt) < WORKTREE_RECONCILIATION_RETRY_INTERVAL
        }) {
            return false;
        }
        reconciliation.last_attempt = Some(now);
        let interrupted_worktree_turns = self
            .interrupted_worktree_turns
            .lock()
            .await
            .clone()
            .unwrap_or_default();
        let interrupted_worktree_task_ids = interrupted_worktree_turns
            .iter()
            .map(|turn| turn.local_task_id.clone())
            .collect::<HashSet<_>>();
        let remaining_queued_turns = self
            .turn_scheduler
            .lock()
            .expect("runtime turn scheduler lock should not be poisoned")
            .queued_turns
            .clone();
        let queued_task_ids = remaining_queued_turns
            .iter()
            .map(|turn| turn.local_task_id.clone())
            .collect::<HashSet<_>>();
        let worktrees = self.worktrees.clone();
        let store = self.store.clone();
        let result = tokio::task::spawn_blocking(move || {
            let reconciled = worktrees.reconcile()?;
            let tasks = store.list_task_summaries(true);
            let interrupted_preparation_errors = reconciled
                .iter()
                .filter(|outcome| outcome.interrupted_preparation)
                .map(|outcome| {
                    (
                        normalize_workspace_path(&outcome.record.path),
                        outcome.record.last_error.clone(),
                    )
                })
                .collect::<HashMap<_, _>>();
            let mut failed_task_ids = HashSet::new();
            for task in tasks.iter().filter(|task| {
                !queued_task_ids.contains(&task.local_task_id)
                    && !matches!(
                        task.status.as_str(),
                        "archived" | "cancelled" | "done" | "failed"
                    )
                    && worktrees.is_managed_path(Path::new(&task.workspace_path))
            }) {
                let normalized_path = normalize_workspace_path(&task.workspace_path);
                let error = interrupted_preparation_errors
                    .get(&normalized_path)
                    .cloned()
                    .flatten()
                    .unwrap_or_else(|| {
                        "Executor restarted during Worktree preparation; runtime was not resumed"
                            .to_owned()
                    });
                let error = if interrupted_preparation_errors.contains_key(&normalized_path) {
                    error
                } else {
                    "Executor restarted while the Worktree task was active; runtime was not resumed"
                        .to_owned()
                };
                if store
                    .update_task(&task.local_task_id, |link| {
                        link.running = false;
                        link.status = "failed".to_owned();
                        link.thread_status = "failed".to_owned();
                        link.turn_status = Some("failed".to_owned());
                        link.updated_at = now_ms();
                        link.completed_at = Some(link.updated_at);
                        if !link.runtime_handle.is_object() {
                            link.runtime_handle = json!({});
                        }
                        if let Some(runtime_handle) = link.runtime_handle.as_object_mut() {
                            runtime_handle.remove("queuePosition");
                            runtime_handle
                                .insert("lastError".to_owned(), Value::String(error.clone()));
                        }
                    })
                    .is_some()
                {
                    failed_task_ids.insert(task.local_task_id.clone());
                }
            }
            for task_id in interrupted_worktree_task_ids {
                if failed_task_ids.contains(&task_id) {
                    continue;
                }
                let error =
                    "Executor restarted before the queued Worktree task began; runtime was not resumed"
                        .to_owned();
                if store
                    .update_task(&task_id, |link| {
                        link.running = false;
                        link.status = "failed".to_owned();
                        link.thread_status = "failed".to_owned();
                        link.turn_status = Some("failed".to_owned());
                        link.updated_at = now_ms();
                        link.completed_at = Some(link.updated_at);
                        if !link.runtime_handle.is_object() {
                            link.runtime_handle = json!({});
                        }
                        if let Some(runtime_handle) = link.runtime_handle.as_object_mut() {
                            runtime_handle.remove("queuePosition");
                            runtime_handle
                                .insert("lastError".to_owned(), Value::String(error.clone()));
                        }
                    })
                    .is_some()
                {
                    failed_task_ids.insert(task_id);
                }
            }
            Ok::<Vec<String>, String>(failed_task_ids.into_iter().collect())
        })
        .await;
        match result {
            Ok(Ok(failed_task_ids)) => {
                for task_id in failed_task_ids {
                    log_executor_event(
                        "interrupted worktree task reconciled without runtime restart",
                        &[("local_task_id", task_id)],
                    );
                }
                if let Err(error) = self.persist_turn_queue(remaining_queued_turns).await {
                    log_executor_event(
                        "runtime turn queue reconciliation persistence failed",
                        &[("error", error.message)],
                    );
                    reconciliation.last_attempt = Some(Instant::now());
                    return false;
                }
                *self.interrupted_worktree_turns.lock().await = None;
                reconciliation.completed = true;
                true
            }
            Ok(Err(error)) => {
                log_executor_event(
                    "worktree startup reconciliation failed",
                    &[("error", error)],
                );
                reconciliation.last_attempt = Some(Instant::now());
                false
            }
            Err(error) => {
                log_executor_event(
                    "worktree startup reconciliation worker failed",
                    &[("error", error.to_string())],
                );
                reconciliation.last_attempt = Some(Instant::now());
                false
            }
        }
    }

    pub(super) async fn register_harness_context(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let request = harness_context::parse_registration_payload(payload)
            .map_err(|error| AppIpcError::new("invalid_request", error))?;
        let loopback = executor_loopback_base_url().ok_or_else(|| {
            AppIpcError::new(
                "runtime_unavailable",
                "Executor HTTP server is not available",
            )
        })?;
        let token =
            harness_context::register_harness_context(&request.scope, request.user, request.model);
        Ok(json!({
            "token": token,
            "baseUrl": format!("{loopback}/v1/harness-context/{token}")
        }))
    }

    pub(super) async fn unregister_harness_context(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let token = string_field(&payload, "token")
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppIpcError::new("invalid_request", "token is required"))?;
        harness_context::unregister_harness_context(&token);
        Ok(json!({"unregistered": true}))
    }

    pub(super) async fn get_runtime_capacity(&self) -> Result<Value, AppIpcError> {
        let scheduler = self
            .turn_scheduler
            .lock()
            .expect("runtime turn scheduler lock should not be poisoned");
        Ok(json!({
            "limit": scheduler.max_concurrent_tasks,
            "active": scheduler.active_tasks,
            "active_task_ids": scheduler.active_task_ids,
            "queued": scheduler.queued_turns.len(),
        }))
    }

    pub(super) async fn get_runtime_settings(&self) -> Result<Value, AppIpcError> {
        let max_concurrent_tasks = self
            .turn_scheduler
            .lock()
            .expect("runtime turn scheduler lock should not be poisoned")
            .max_concurrent_tasks;
        Ok(json!({ "maxConcurrentTasks": max_concurrent_tasks }))
    }

    pub(super) async fn update_runtime_settings(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let max_concurrent_tasks = payload
            .get("maxConcurrentTasks")
            .or_else(|| payload.get("max_concurrent_tasks"))
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .ok_or_else(|| AppIpcError::new("bad_request", "maxConcurrentTasks is required"))?;
        if !(MIN_MAX_CONCURRENT_TASKS..=MAX_MAX_CONCURRENT_TASKS).contains(&max_concurrent_tasks) {
            return Err(AppIpcError::new(
                "bad_request",
                format!(
                    "maxConcurrentTasks must be between {MIN_MAX_CONCURRENT_TASKS} and {MAX_MAX_CONCURRENT_TASKS}"
                ),
            ));
        }
        write_runtime_settings(&RuntimeSettings {
            max_concurrent_tasks,
        })?;
        self.update_max_concurrent_tasks(max_concurrent_tasks).await;
        Ok(json!({ "maxConcurrentTasks": max_concurrent_tasks }))
    }

    pub(super) async fn search_workspace(&self, payload: Value) -> Result<Value, AppIpcError> {
        let root = string_field(&payload, "root")
            .ok_or_else(|| AppIpcError::new("bad_request", "root is required"))?;
        let query = string_field(&payload, "query").unwrap_or_default();
        if query.trim().is_empty() {
            return Ok(json!({ "files": [] }));
        }

        let root = fs::canonicalize(&root)
            .map_err(|error| AppIpcError::new("invalid_workspace_root", error.to_string()))?;
        if !root.is_dir() {
            return Err(AppIpcError::new(
                "invalid_workspace_root",
                "Workspace search root is not a directory",
            ));
        }
        if !self.workspace_search_root_is_allowed(&root) {
            return Err(AppIpcError::new(
                "invalid_workspace_root",
                "Workspace search root has not been opened",
            ));
        }

        let cancellation_token = string_field(&payload, "cancellationToken")
            .or_else(|| string_field(&payload, "cancellation_token"));
        let response = self
            .codex_app_server
            .request(
                "fuzzyFileSearch",
                json!({
                    "query": query,
                    "roots": [root.to_string_lossy()],
                    "cancellationToken": cancellation_token,
                }),
            )
            .await
            .map_err(|error| AppIpcError::new("workspace_search_failed", error))?;
        let files = response
            .get("files")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| {
                        json!({
                            "root": item.get("root").cloned().unwrap_or(Value::Null),
                            "path": item.get("path").cloned().unwrap_or(Value::Null),
                            "fileName": item.get("file_name").cloned().unwrap_or(Value::Null),
                            "matchType": item.get("match_type").cloned().unwrap_or(Value::Null),
                            "score": item.get("score").cloned().unwrap_or(Value::Null),
                            "indices": item.get("indices").cloned().unwrap_or(Value::Null),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(json!({ "files": files }))
    }

    pub(super) fn workspace_search_root_is_allowed(&self, root: &Path) -> bool {
        if self
            .opened_workspace_roots
            .lock()
            .map(|roots| {
                roots
                    .iter()
                    .any(|allowed| root == allowed || root.starts_with(allowed))
            })
            .unwrap_or(false)
        {
            return true;
        }
        let project_index = CodexGlobalProjectIndex::load();
        let project_paths = project_index
            .projects()
            .iter()
            .map(|project| project.workspace_path.as_str());
        let task_paths = self
            .store
            .list_task_summaries(true)
            .into_iter()
            .map(|task| task.workspace_path)
            .collect::<Vec<_>>();

        project_paths
            .chain(task_paths.iter().map(String::as_str))
            .filter_map(|path| fs::canonicalize(path).ok())
            .any(|allowed| root == allowed || root.starts_with(&allowed))
    }

    pub(super) async fn get_worktree_capabilities(&self) -> Result<Value, AppIpcError> {
        Ok(json!({
            "success": true,
            "deviceId": self.device_id,
            "runtimeWorktrees": self.worktrees.capabilities(),
        }))
    }

    pub(super) async fn preflight_worktree(&self, payload: Value) -> Result<Value, AppIpcError> {
        let source_path = string_field(&payload, "sourcePath")
            .or_else(|| string_field(&payload, "source_path"))
            .ok_or_else(|| AppIpcError::new("bad_request", "sourcePath is required"))?;
        let git_ref = string_field(&payload, "ref")
            .or_else(|| string_field(&payload, "gitRef"))
            .or_else(|| string_field(&payload, "git_ref"));
        let worktrees = self.worktrees.clone();
        let preflight = tokio::task::spawn_blocking(move || {
            worktrees.preflight(Path::new(&source_path), git_ref.as_deref())
        })
        .await
        .map_err(|error| {
            AppIpcError::new(
                "worktree_preflight_failed",
                format!("Worktree preflight task failed: {error}"),
            )
        })?;
        let mut value = serde_json::to_value(preflight)
            .map_err(|error| AppIpcError::new("worktree_preflight_failed", error.to_string()))?;
        value["success"] = Value::Bool(true);
        value["deviceId"] = Value::String(self.device_id.clone());
        Ok(value)
    }

    pub(super) async fn get_worktree_settings(&self) -> Result<Value, AppIpcError> {
        let worktrees = self.worktrees.clone();
        let settings = tokio::task::spawn_blocking(move || worktrees.settings())
            .await
            .map_err(|error| {
                AppIpcError::new(
                    "worktree_settings_failed",
                    format!("Worktree settings task failed: {error}"),
                )
            })?;
        let mut value = serde_json::to_value(settings)
            .map_err(|error| AppIpcError::new("worktree_settings_failed", error.to_string()))?;
        value["deviceId"] = Value::String(self.device_id.clone());
        Ok(value)
    }

    pub(super) async fn update_worktree_settings(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let patch = serde_json::from_value::<WorktreeSettingsPatch>(payload)
            .map_err(|error| AppIpcError::new("invalid_worktree_settings", error.to_string()))?;
        let worktrees = self.worktrees.clone();
        let settings = tokio::task::spawn_blocking(move || worktrees.update_settings(patch))
            .await
            .map_err(|error| {
                AppIpcError::new(
                    "worktree_settings_failed",
                    format!("Worktree settings task failed: {error}"),
                )
            })?
            .map_err(|error| AppIpcError::new("worktree_settings_failed", error))?;
        self.schedule_worktree_prune();
        let mut value = serde_json::to_value(settings)
            .map_err(|error| AppIpcError::new("worktree_settings_failed", error.to_string()))?;
        value["deviceId"] = Value::String(self.device_id.clone());
        Ok(value)
    }

    pub(super) async fn prepare_worktree(&self, payload: Value) -> Result<Value, AppIpcError> {
        let source_path = string_field(&payload, "sourcePath")
            .or_else(|| string_field(&payload, "source_path"))
            .ok_or_else(|| AppIpcError::new("bad_request", "sourcePath is required"))?;
        let worktree_id = string_field(&payload, "worktreeId")
            .or_else(|| string_field(&payload, "worktree_id"))
            .ok_or_else(|| AppIpcError::new("bad_request", "worktreeId is required"))?;
        let git_ref = string_field(&payload, "ref");
        let permanent = payload
            .get("permanent")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let worktrees = self.worktrees.clone();
        let record = tokio::task::spawn_blocking(move || {
            worktrees.prepare(
                Path::new(&source_path),
                &worktree_id,
                git_ref.as_deref(),
                permanent,
            )
        })
        .await
        .map_err(|error| {
            AppIpcError::new(
                "worktree_prepare_failed",
                format!("Worktree preparation task failed: {error}"),
            )
        })?
        .map_err(|error| AppIpcError::new(worktree_error_code(&error), error))?;
        self.schedule_worktree_prune();
        Ok(json!({
            "success": true,
            "deviceId": self.device_id,
            "worktree": record,
            "path": record.path,
        }))
    }

    pub(super) fn schedule_worktree_prune(&self) {
        let generation = self
            .worktree_cleanup_generation
            .fetch_add(1, Ordering::SeqCst)
            + 1;
        let cleanup_generation = self.worktree_cleanup_generation.clone();
        let worktrees = self.worktrees.clone();
        let store = self.store.clone();
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        runtime.spawn(async move {
            sleep(WORKTREE_AUTO_CLEANUP_IDLE_DELAY).await;
            let mut empty_rounds = 0;
            loop {
                if cleanup_generation.load(Ordering::SeqCst) != generation {
                    return;
                }

                let worktrees = worktrees.clone();
                let store = store.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let tasks = store.list_task_summaries(true);
                    let has_running_tasks = tasks.iter().any(|task| task.running);
                    worktrees
                        .prune_auto_batch(&tasks)
                        .map(|batch| (batch, has_running_tasks))
                })
                .await;
                match result {
                    Ok(Ok((batch, _))) if !batch.removed.is_empty() => {
                        for error in batch.errors {
                            log_executor_event(
                                "automatic worktree cleanup skipped a worktree",
                                &[("error", error)],
                            );
                        }
                        empty_rounds = 0;
                        sleep(WORKTREE_AUTO_CLEANUP_BATCH_DELAY).await;
                    }
                    Ok(Ok((batch, _))) if !batch.errors.is_empty() => {
                        for error in batch.errors {
                            log_executor_event(
                                "automatic worktree cleanup skipped a worktree",
                                &[("error", error)],
                            );
                        }
                        sleep(WORKTREE_AUTO_CLEANUP_ERROR_DELAY).await;
                    }
                    Ok(Ok((_, has_running_tasks)))
                        if has_running_tasks
                            && empty_rounds + 1 < WORKTREE_AUTO_CLEANUP_MAX_EMPTY_ROUNDS =>
                    {
                        empty_rounds += 1;
                        sleep(WORKTREE_AUTO_CLEANUP_BATCH_DELAY).await;
                    }
                    Ok(Ok(_)) => return,
                    Ok(Err(error)) => {
                        log_executor_event(
                            "automatic worktree cleanup failed",
                            &[("error", error)],
                        );
                        sleep(WORKTREE_AUTO_CLEANUP_ERROR_DELAY).await;
                    }
                    Err(error) => {
                        log_executor_event(
                            "automatic worktree cleanup worker failed",
                            &[("error", error.to_string())],
                        );
                        return;
                    }
                }
            }
        });
    }

    pub(super) async fn list_worktrees(&self) -> Result<Value, AppIpcError> {
        let worktrees = self.worktrees.clone();
        let store = self.store.clone();
        let entries =
            tokio::task::spawn_blocking(move || worktrees.list(&store.list_task_summaries(true)))
                .await
                .map_err(|error| {
                    AppIpcError::new(
                        "worktree_list_failed",
                        format!("Worktree list task failed: {error}"),
                    )
                })?
                .map_err(|error| AppIpcError::new("worktree_list_failed", error))?;
        let items = entries
            .into_iter()
            .map(|(record, tasks)| {
                json!({
                    "deviceId": self.device_id,
                    "worktreeId": record.worktree_id,
                    "path": record.path,
                    "repositoryName": record.repository_name,
                    "sourcePath": record.source_path,
                    "createdAt": record.created_at,
                    "updatedAt": record.updated_at,
                    "state": record.state,
                    "snapshotAt": record.snapshot_at,
                    "lastError": record.last_error,
                    "conversations": tasks.into_iter().map(|task| json!({
                        "deviceId": self.device_id,
                        "taskId": task.local_task_id,
                        "threadId": task.thread_id,
                        "workspacePath": task.workspace_path,
                        "title": task.title,
                        "status": task.status,
                        "running": task.running,
                        "updatedAt": task.updated_at,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({"success": true, "deviceId": self.device_id, "items": items}))
    }

    pub(super) async fn delete_worktree(&self, payload: Value) -> Result<Value, AppIpcError> {
        let path = string_field(&payload, "path")
            .ok_or_else(|| AppIpcError::new("bad_request", "path is required"))?;
        let preserve_snapshot = bool_field(&payload, "preserveSnapshot")
            .or_else(|| bool_field(&payload, "preserve_snapshot"))
            .unwrap_or(true);
        let store = self.store.clone();
        let linked_path = path.clone();
        let linked = tokio::task::spawn_blocking(move || {
            store
                .list_task_summaries(true)
                .into_iter()
                .filter(|task| {
                    normalize_workspace_path(&task.workspace_path)
                        == normalize_workspace_path(&linked_path)
                })
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|error| {
            AppIpcError::new(
                "worktree_list_failed",
                format!("Worktree task lookup failed: {error}"),
            )
        })?;
        for task in linked.iter().filter(|task| task.status != "archived") {
            let result = self
                .archive_task(
                    json!({"taskId": task.local_task_id, "workspacePath": task.workspace_path}),
                )
                .await?;
            if result["accepted"] != true {
                return Err(AppIpcError::new(
                    "worktree_archive_failed",
                    result
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Failed to archive linked task"),
                ));
            }
        }
        let worktrees = self.worktrees.clone();
        let delete_path = PathBuf::from(&path);
        let record =
            tokio::task::spawn_blocking(move || worktrees.delete(&delete_path, preserve_snapshot))
                .await
                .map_err(|error| {
                    AppIpcError::new(
                        "worktree_delete_failed",
                        format!("Worktree deletion task failed: {error}"),
                    )
                })?
                .map_err(|error| AppIpcError::new("worktree_delete_failed", error))?;
        Ok(json!({
            "success": true,
            "deviceId": self.device_id,
            "worktree": record,
            "archivedTaskCount": linked.iter().filter(|task| task.status != "archived").count(),
        }))
    }

    pub(super) async fn restore_worktree(&self, payload: Value) -> Result<Value, AppIpcError> {
        let path = string_field(&payload, "path")
            .or_else(|| workspace_path(&payload))
            .ok_or_else(|| AppIpcError::new("bad_request", "path is required"))?;
        let worktrees = self.worktrees.clone();
        let restore_path = PathBuf::from(path);
        let record = tokio::task::spawn_blocking(move || worktrees.restore(&restore_path))
            .await
            .map_err(|error| {
                AppIpcError::new(
                    "worktree_restore_failed",
                    format!("Worktree restore task failed: {error}"),
                )
            })?
            .map_err(|error| AppIpcError::new("worktree_restore_failed", error))?;
        Ok(json!({"success": true, "deviceId": self.device_id, "worktree": record}))
    }

    pub(super) async fn prune_worktrees(&self) -> Result<Value, AppIpcError> {
        let worktrees = self.worktrees.clone();
        let store = self.store.clone();
        let removed =
            tokio::task::spawn_blocking(move || worktrees.prune(&store.list_task_summaries(true)))
                .await
                .map_err(|error| {
                    AppIpcError::new(
                        "worktree_prune_failed",
                        format!("Worktree prune task failed: {error}"),
                    )
                })?
                .map_err(|error| AppIpcError::new("worktree_prune_failed", error))?;
        Ok(json!({"success": true, "deviceId": self.device_id, "removed": removed}))
    }

    pub(super) async fn get_keybindings(&self) -> Result<Value, AppIpcError> {
        let path = runtime_work_dir().join("keybindings.json");
        let Ok(content) = fs::read_to_string(&path) else {
            return Ok(json!({ "keybindings": [] }));
        };
        let keybindings = serde_json::from_str::<Value>(&content).map_err(|error| {
            AppIpcError::new(
                "invalid_keybindings",
                format!("Failed to parse {}: {error}", path.display()),
            )
        })?;
        if !keybindings.is_array() {
            return Err(AppIpcError::new(
                "invalid_keybindings",
                "keybindings.json must contain an array",
            ));
        }
        Ok(json!({ "keybindings": keybindings }))
    }

    pub(super) async fn get_codex_stream_debug(&self) -> Result<Value, AppIpcError> {
        Ok(json!({ "enabled": codex_stream_debug_enabled() }))
    }

    pub(super) async fn register_harness_proxy(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let scope = string_field(&payload, "scope")
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppIpcError::new("invalid_request", "scope is required"))?;
        let upstream = payload
            .get("upstream")
            .cloned()
            .ok_or_else(|| AppIpcError::new("invalid_request", "upstream is required"))
            .and_then(|value| {
                serde_json::from_value::<local_model_proxy::LocalModelProxyUpstream>(value).map_err(
                    |error| {
                        AppIpcError::new(
                            "invalid_request",
                            format!("Invalid harness proxy upstream: {error}"),
                        )
                    },
                )
            })?;
        let loopback = executor_loopback_base_url().ok_or_else(|| {
            AppIpcError::new(
                "runtime_unavailable",
                "Executor HTTP server is not available",
            )
        })?;
        let token = local_model_proxy::register_harness(&scope, upstream);
        Ok(json!({
            "token": token,
            "baseUrl": format!("{loopback}/v1/harness-router/{token}")
        }))
    }

    pub(super) async fn unregister_harness_proxy(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let token = string_field(&payload, "token")
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppIpcError::new("invalid_request", "token is required"))?;
        local_model_proxy::unregister_harness(&token);
        Ok(json!({"unregistered": true}))
    }

    pub(super) async fn write_custom_codex_catalog(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let entries = payload
            .get("models")
            .and_then(Value::as_array)
            .ok_or_else(|| AppIpcError::new("invalid_request", "models must be an array"))?;
        let count = crate::server::codex_model_catalog::write_custom_models(entries)
            .map_err(|error| AppIpcError::new("invalid_model_catalog", error))?;
        Ok(json!({"saved": true, "modelCount": count}))
    }

    pub(super) async fn restart_codex_app_server(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let expected_models = crate::server::codex_model_catalog::custom_model_slugs();
        self.restart_codex_app_server_with_expected_models(payload, expected_models)
            .await
    }

    pub(super) async fn restart_codex_app_server_with_expected_models(
        &self,
        payload: Value,
        expected_models: Vec<String>,
    ) -> Result<Value, AppIpcError> {
        let active_task_count = self
            .active_codex_turns
            .lock()
            .expect("active Codex turn registry should not be poisoned")
            .len();
        let force = bool_field(&payload, "force").unwrap_or(false);
        let if_idle = bool_field(&payload, "ifIdle").unwrap_or(false);
        if active_task_count > 0 && if_idle && !force {
            return Ok(json!({
                "restarted": false,
                "requiresConfirmation": true,
                "activeTaskCount": active_task_count,
                "pendingRequestCount": 0,
            }));
        }
        if payload.get("proxyUrl").is_some() || payload.get("proxy_url").is_some() {
            let proxy_url = optional_proxy_url(&payload)?;
            self.configure_codex_runtime_proxy(proxy_url, true)
                .await
                .map_err(|error| AppIpcError::new("codex_runtime_config_update_failed", error))?;
        }
        if if_idle && !force {
            match self.codex_app_server.restart_if_no_pending_requests().await {
                Ok(()) => {}
                Err(count) => {
                    return Ok(json!({
                        "restarted": false,
                        "requiresConfirmation": true,
                        "activeTaskCount": active_task_count,
                        "pendingRequestCount": count,
                    }));
                }
            }
        } else {
            self.codex_app_server.restart().await;
        }
        crate::server::codex_model_catalog::invalidate_models_cache()
            .map_err(|error| AppIpcError::new("codex_cache_invalidation_failed", error))?;
        if !expected_models.is_empty() {
            let mut loaded = false;
            for _ in 0..20 {
                let response = self
                    .codex_app_server
                    .request("model/list", json!({"includeHidden": true}))
                    .await
                    .map_err(|error| AppIpcError::new("codex_restart_failed", error))?;
                let available = response
                    .get("data")
                    .and_then(Value::as_array)
                    .map(|models| {
                        expected_models.iter().all(|expected| {
                            models.iter().any(|model| {
                                model.get("id").and_then(Value::as_str) == Some(expected.as_str())
                            })
                        })
                    })
                    .unwrap_or(false);
                if available {
                    loaded = true;
                    break;
                }
                sleep(Duration::from_millis(100)).await;
            }
            if !loaded {
                return Err(AppIpcError::new(
                    "codex_catalog_not_loaded",
                    "Codex restarted but did not load the custom model catalog",
                ));
            }
        }
        Ok(json!({
            "restarted": true,
            "requiresConfirmation": false,
            "activeTaskCount": active_task_count,
            "pendingRequestCount": 0,
        }))
    }

    pub(super) async fn set_codex_stream_debug(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let Some(enabled) = bool_field(&payload, "enabled") else {
            return Err(AppIpcError::new(
                "invalid_request",
                "enabled must be a boolean",
            ));
        };
        set_codex_stream_debug_enabled(enabled);
        Ok(json!({ "enabled": codex_stream_debug_enabled() }))
    }

    pub(super) async fn update_keybindings(&self, payload: Value) -> Result<Value, AppIpcError> {
        let Some(keybindings) = payload.get("keybindings").cloned() else {
            return Err(AppIpcError::new(
                "invalid_request",
                "Missing keybindings array",
            ));
        };
        if !keybindings.is_array() {
            return Err(AppIpcError::new(
                "invalid_request",
                "keybindings must be an array",
            ));
        }

        let path = runtime_work_dir().join("keybindings.json");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                AppIpcError::new(
                    "keybindings_write_failed",
                    format!("Failed to create {}: {error}", parent.display()),
                )
            })?;
        }
        let payload = serde_json::to_vec_pretty(&keybindings).map_err(|error| {
            AppIpcError::new(
                "keybindings_write_failed",
                format!("Failed to serialize keybindings: {error}"),
            )
        })?;
        fs::write(&path, payload).map_err(|error| {
            AppIpcError::new(
                "keybindings_write_failed",
                format!("Failed to write {}: {error}", path.display()),
            )
        })?;
        Ok(json!({ "keybindings": keybindings }))
    }
}

fn runtime_settings_path() -> PathBuf {
    runtime_work_dir().join("settings.json")
}

pub(super) fn read_runtime_settings() -> RuntimeSettings {
    let path = runtime_settings_path();
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return RuntimeSettings::default();
        }
        Err(error) => {
            log_executor_event(
                "runtime settings read failed",
                &[
                    ("path", path.display().to_string()),
                    ("error", error.to_string()),
                ],
            );
            return RuntimeSettings::default();
        }
    };
    let settings = match serde_json::from_str::<RuntimeSettings>(&content) {
        Ok(settings) => settings,
        Err(error) => {
            log_executor_event(
                "runtime settings parse failed",
                &[
                    ("path", path.display().to_string()),
                    ("error", error.to_string()),
                ],
            );
            return RuntimeSettings::default();
        }
    };
    RuntimeSettings {
        max_concurrent_tasks: settings
            .max_concurrent_tasks
            .clamp(MIN_MAX_CONCURRENT_TASKS, MAX_MAX_CONCURRENT_TASKS),
    }
}

fn write_runtime_settings(settings: &RuntimeSettings) -> Result<(), AppIpcError> {
    let path = runtime_settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            AppIpcError::new(
                "runtime_settings_failed",
                format!("Failed to create {}: {error}", parent.display()),
            )
        })?;
    }
    let payload = serde_json::to_vec_pretty(settings)
        .map_err(|error| AppIpcError::new("runtime_settings_failed", error.to_string()))?;
    fs::write(&path, payload).map_err(|error| {
        AppIpcError::new(
            "runtime_settings_failed",
            format!("Failed to write {}: {error}", path.display()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn handler_uses_the_frozen_manager_storage_capability_and_gate() {
        let root = tempfile::tempdir().expect("temporary runtime work directory");
        let mut handler = RuntimeWorkRpcHandler::new("device-cloud", "/bin/false");
        handler.worktrees = WorktreeManager::new_for_device_with_storage(
            root.path().join("worktrees.json"),
            "device-cloud",
            false,
        );

        let capabilities = handler.get_worktree_capabilities().await.unwrap();
        let preflight = handler
            .preflight_worktree(json!({"sourcePath": root.path().join("source")}))
            .await
            .unwrap();
        let prepare_error = handler
            .prepare_worktree(json!({
                "sourcePath": root.path().join("source"),
                "worktreeId": "task-1",
            }))
            .await
            .unwrap_err();

        assert_eq!(
            capabilities["runtimeWorktrees"]["persistentStorageVerified"],
            false
        );
        assert_eq!(preflight["supported"], false);
        assert_eq!(
            preflight["errorCode"],
            "worktree_persistent_storage_unverified"
        );
        assert_eq!(prepare_error.code, "worktree_persistent_storage_unverified");
    }
}
