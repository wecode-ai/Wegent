// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
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

    pub(super) async fn get_worktree_settings(&self) -> Result<Value, AppIpcError> {
        let settings = self.worktrees.settings();
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
        let settings = self
            .worktrees
            .update_settings(patch)
            .map_err(|error| AppIpcError::new("worktree_settings_failed", error))?;
        let _ = self.worktrees.prune(&self.store.list_task_summaries(true));
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
        let record = self
            .worktrees
            .prepare(
                Path::new(&source_path),
                &worktree_id,
                git_ref.as_deref(),
                permanent,
            )
            .map_err(|error| AppIpcError::new("worktree_prepare_failed", error))?;
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
        tokio::spawn(async move {
            loop {
                sleep(WORKTREE_AUTO_CLEANUP_IDLE_DELAY).await;
                if cleanup_generation.load(Ordering::SeqCst) != generation {
                    return;
                }

                let tasks = store.list_task_summaries(true);
                if tasks.iter().any(|task| task.running) {
                    continue;
                }

                let result = tokio::task::spawn_blocking(move || worktrees.prune(&tasks)).await;
                match result {
                    Ok(Err(_)) | Err(_) | Ok(Ok(_)) => {}
                }
                return;
            }
        });
    }

    pub(super) async fn list_worktrees(&self) -> Result<Value, AppIpcError> {
        let entries = self
            .worktrees
            .list(&self.store.list_task_summaries(true))
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
        let linked = self
            .store
            .list_task_summaries(true)
            .into_iter()
            .filter(|task| {
                normalize_workspace_path(&task.workspace_path) == normalize_workspace_path(&path)
            })
            .collect::<Vec<_>>();
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
        let record = self
            .worktrees
            .delete(Path::new(&path), preserve_snapshot)
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
        let record = self
            .worktrees
            .restore(Path::new(&path))
            .map_err(|error| AppIpcError::new("worktree_restore_failed", error))?;
        Ok(json!({"success": true, "deviceId": self.device_id, "worktree": record}))
    }

    pub(super) async fn prune_worktrees(&self) -> Result<Value, AppIpcError> {
        let removed = self
            .worktrees
            .prune(&self.store.list_task_summaries(true))
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
            }));
        }
        self.codex_app_server.restart().await;
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
