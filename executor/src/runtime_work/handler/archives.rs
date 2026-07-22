// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn archive_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        log_executor_event(
            "runtime task archive requested",
            &[
                (
                    "payload_task_id",
                    runtime_task_id(&payload).unwrap_or_else(|| "none".to_owned()),
                ),
                (
                    "payload_workspace_path",
                    workspace_path(&payload).unwrap_or_else(|| "none".to_owned()),
                ),
                (
                    "payload_address_task_id",
                    payload
                        .get("address")
                        .and_then(runtime_task_id)
                        .unwrap_or_else(|| "none".to_owned()),
                ),
            ],
        );
        let mut link = self.task_link_from_payload(&payload, false).await?;
        let archive_thread_id = runtime_session_id_from_link(&link);
        log_runtime_archive_link("runtime task archive resolved link", &link, false);
        if let Some(thread_id) = archive_thread_id.as_deref() {
            if let Err(error) = self
                .call_codex_thread_method("thread/archive", json!({"threadId": thread_id}))
                .await
            {
                log_executor_event(
                    "runtime task archive codex failed",
                    &[
                        ("local_task_id", link.local_task_id.clone()),
                        ("thread_id", thread_id.to_owned()),
                        ("error", error.clone()),
                    ],
                );
                if codex_error_is_missing_rollout(&error, thread_id) {
                    return Ok(self
                        .cleanup_missing_rollout_task(&link, thread_id, error)
                        .await);
                }
                return Ok(task_action_failure(&link, error));
            }
            log_executor_event(
                "runtime task archive codex accepted",
                &[
                    ("local_task_id", link.local_task_id.clone()),
                    ("thread_id", thread_id.to_owned()),
                ],
            );
            self.codex_app_server.unsubscribe_thread(thread_id).await;
            self.remove_thread_event_route(thread_id);
        } else {
            log_executor_event(
                "runtime task archive skipped codex",
                &[
                    ("local_task_id", link.local_task_id.clone()),
                    ("reason", "missing_thread_id".to_owned()),
                ],
            );
        }

        link.status = "archived".to_owned();
        link.running = false;
        link.updated_at = now_ms();
        self.upsert_local_task(link.clone());
        log_runtime_archive_link("runtime task archive stored link", &link, true);
        Ok(task_action_success(&link))
    }

    pub(super) async fn cleanup_missing_rollout_task(
        &self,
        link: &RuntimeTaskLink,
        thread_id: &str,
        archive_error: String,
    ) -> Value {
        let started_at = Instant::now();
        let delete_result = self
            .call_codex_thread_method_without_list_invalidation(
                "thread/delete",
                json!({"threadId": thread_id}),
            )
            .await;
        match &delete_result {
            Ok(_) => log_executor_event(
                "runtime task archive missing rollout deleted codex thread",
                &[
                    ("local_task_id", link.local_task_id.clone()),
                    ("thread_id", thread_id.to_owned()),
                    ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
                ],
            ),
            Err(error) => log_executor_event(
                "runtime task archive missing rollout codex delete failed",
                &[
                    ("local_task_id", link.local_task_id.clone()),
                    ("thread_id", thread_id.to_owned()),
                    ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
                    ("error", error.clone()),
                ],
            ),
        }

        self.mark_archived_link_deleted(link);
        self.store.delete_task(&link.local_task_id);
        let mut response = task_action_success(link);
        response["cleaned"] = json!(true);
        response["cleanupReason"] = json!("missing_rollout");
        response["archiveError"] = json!(archive_error);
        if let Err(error) = delete_result {
            response["deleteError"] = json!(error);
        }
        response
    }

    pub(super) async fn archive_project_conversations(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let project_index = CodexGlobalProjectIndex::load();
        let workspace_path = runtime_project_workspace_path(&payload, &project_index)
            .ok_or_else(|| AppIpcError::new("bad_request", "runtimeProjectKey is required"))?;
        let links =
            self.visible_links_for_projects(self.collect_links(false).await, &project_index);
        let project_links = links
            .into_iter()
            .filter(|link| {
                let group_path = link
                    .group_workspace_path
                    .clone()
                    .unwrap_or_else(|| workspace_group_path(&link.workspace_path));
                group_path == workspace_path
            })
            .collect::<Vec<_>>();
        self.archive_links_bulk(project_links).await
    }

    pub(super) async fn archive_all_conversations(&self) -> Result<Value, AppIpcError> {
        let project_index = CodexGlobalProjectIndex::load();
        let links =
            self.visible_links_for_projects(self.collect_links(false).await, &project_index);
        self.archive_links_bulk(links).await
    }

    pub(super) async fn archive_links_bulk(
        &self,
        links: Vec<RuntimeTaskLink>,
    ) -> Result<Value, AppIpcError> {
        let requested_count = links.len();
        let mut accepted_count = 0_usize;
        let mut results = Vec::new();
        for link in links {
            let result = self
                .archive_task(json!({
                    "taskId": link.local_task_id,
                    "workspacePath": link.workspace_path,
                    "runtimeHandle": link.runtime_handle,
                }))
                .await?;
            if result["accepted"].as_bool() == Some(true) {
                accepted_count += 1;
            }
            results.push(result);
        }

        Ok(json!({
            "success": accepted_count == requested_count,
            "accepted": accepted_count == requested_count,
            "requestedCount": requested_count,
            "acceptedCount": accepted_count,
            "results": results,
        }))
    }

    pub(super) async fn unarchive_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let mut link = self.task_link_from_payload(&payload, true).await?;
        if let Err(error) = self
            .worktrees
            .restore_if_known(Path::new(&link.workspace_path))
        {
            return Ok(task_action_failure(&link, error));
        }
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

    pub(super) async fn rename_task(&self, payload: Value) -> Result<Value, AppIpcError> {
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

    pub(super) async fn get_task_goal(&self, payload: Value) -> Result<Value, AppIpcError> {
        let link = self.task_link_from_payload(&payload, false).await?;
        let Some(thread_id) = codex_thread_id_from_link(&link) else {
            return Ok(task_goal_missing_session(&link));
        };

        match self
            .call_codex_thread_method("thread/goal/get", json!({"threadId": thread_id}))
            .await
        {
            Ok(result) => {
                self.sync_runtime_task_goal_status(
                    &link.local_task_id,
                    result
                        .get("goal")
                        .and_then(|goal| string_field(goal, "status")),
                );
                let mut response = task_action_success(&link);
                response["goal"] = result.get("goal").cloned().unwrap_or(Value::Null);
                Ok(response)
            }
            Err(error) => Ok(task_action_failure(&link, error)),
        }
    }

    pub(super) async fn set_task_goal(&self, payload: Value) -> Result<Value, AppIpcError> {
        let link = self.task_link_from_payload(&payload, false).await?;
        let Some(thread_id) = codex_thread_id_from_link(&link) else {
            return Ok(task_goal_missing_session(&link));
        };

        let mut params = Map::new();
        params.insert("threadId".to_owned(), Value::String(thread_id));
        if let Some(objective) = payload.get("objective").cloned() {
            params.insert("objective".to_owned(), objective);
        }
        if let Some(status) = payload.get("status").cloned() {
            params.insert("status".to_owned(), status);
        }
        if let Some(token_budget) = payload
            .get("tokenBudget")
            .or_else(|| payload.get("token_budget"))
            .cloned()
        {
            params.insert("tokenBudget".to_owned(), token_budget);
        }

        match self
            .call_codex_thread_method("thread/goal/set", Value::Object(params))
            .await
        {
            Ok(result) => {
                self.sync_runtime_task_goal_status(
                    &link.local_task_id,
                    result
                        .get("goal")
                        .and_then(|goal| string_field(goal, "status")),
                );
                let mut response = task_action_success(&link);
                response["goal"] = result.get("goal").cloned().unwrap_or(Value::Null);
                Ok(response)
            }
            Err(error) => Ok(task_action_failure(&link, error)),
        }
    }

    pub(super) async fn clear_task_goal(&self, payload: Value) -> Result<Value, AppIpcError> {
        let link = self.task_link_from_payload(&payload, false).await?;
        let Some(thread_id) = codex_thread_id_from_link(&link) else {
            return Ok(task_goal_missing_session(&link));
        };

        match self
            .call_codex_thread_method("thread/goal/clear", json!({"threadId": thread_id}))
            .await
        {
            Ok(result) => {
                self.sync_runtime_task_goal_status(&link.local_task_id, None);
                let mut response = task_action_success(&link);
                response["cleared"] = result.get("cleared").cloned().unwrap_or(Value::Bool(false));
                Ok(response)
            }
            Err(error) => Ok(task_action_failure(&link, error)),
        }
    }

    pub(super) async fn delete_archived_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let link = self.task_link_from_payload(&payload, true).await?;
        Ok(self.delete_archived_link(link).await)
    }

    pub(super) async fn delete_archived_link(&self, link: RuntimeTaskLink) -> Value {
        self.mark_archived_link_deleted(&link);
        if let Err(error) = self.archived_delete_tx.send(link.clone()) {
            log_executor_event(
                "runtime archived conversation background enqueue failed",
                &[
                    ("local_task_id", link.local_task_id.clone()),
                    ("error", error.to_string()),
                ],
            );
        }

        let mut response = task_action_success(&link);
        response["deleted"] = json!(true);
        response["cleanup"] = json!({
            "background": true,
            "taskId": link.local_task_id,
            "workspacePath": link.workspace_path,
        });
        response
    }

    pub(super) fn spawn_archived_delete_worker(
        &self,
        mut rx: mpsc::UnboundedReceiver<RuntimeTaskLink>,
    ) {
        let handler = self.clone();
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        handle.spawn(async move {
            while let Some(link) = rx.recv().await {
                handler.delete_archived_link_background(link).await;
                sleep(ARCHIVED_BACKGROUND_DELETE_INTERVAL).await;
            }
        });
    }

    pub(super) async fn delete_archived_link_background(&self, link: RuntimeTaskLink) {
        if let Some(thread_id) = link.thread_id.as_deref() {
            let started_at = Instant::now();
            match self
                .call_codex_thread_method_without_list_invalidation(
                    "thread/delete",
                    json!({"threadId": thread_id}),
                )
                .await
            {
                Ok(_) => {
                    let elapsed = started_at.elapsed();
                    if elapsed >= ARCHIVED_BACKGROUND_THREAD_DELETE_SLOW_THRESHOLD {
                        log_executor_event(
                            "runtime archived conversation background thread delete slow",
                            &[
                                ("local_task_id", link.local_task_id.clone()),
                                ("thread_id", thread_id.to_owned()),
                                ("elapsed_ms", elapsed.as_millis().to_string()),
                            ],
                        );
                    }
                }
                Err(error) => {
                    log_executor_event(
                        "runtime archived conversation background thread delete failed",
                        &[
                            ("local_task_id", link.local_task_id.clone()),
                            ("thread_id", thread_id.to_owned()),
                            ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
                            ("error", error),
                        ],
                    );
                }
            }
        }

        self.store.delete_task(&link.local_task_id);
        let cleanup_link = link.clone();
        let cleanup = tokio::task::spawn_blocking(move || {
            cleanup_task_files_response(&cleanup_link, true, false)
        })
        .await
        .unwrap_or_else(|error| {
            json!({
                "taskId": link.local_task_id,
                "workspacePath": link.workspace_path,
                "targetCount": 0,
                "cleanableCount": 0,
                "skippedCount": 0,
                "errorCount": 1,
                "bytes": 0,
                "items": [],
                "error": error.to_string(),
            })
        });
        log_executor_event(
            "runtime archived conversation background cleanup finished",
            &[
                ("local_task_id", link.local_task_id.clone()),
                (
                    "error_count",
                    cleanup
                        .get("errorCount")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        .to_string(),
                ),
            ],
        );
        let has_other_link = self.store.list_task_summaries(true).iter().any(|task| {
            normalize_workspace_path(&task.workspace_path)
                == normalize_workspace_path(&link.workspace_path)
        });
        if !has_other_link {
            if let Err(error) = self
                .worktrees
                .forget_if_known(Path::new(&link.workspace_path))
            {
                log_executor_event(
                    "runtime archived conversation worktree snapshot cleanup failed",
                    &[("local_task_id", link.local_task_id), ("error", error)],
                );
            }
        }
    }

    pub(super) async fn delete_archived_tasks_bulk(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let links = self.archived_cleanup_links(&payload).await?;
        let results = stream::iter(links)
            .map(|link| {
                let handler = self.clone();
                async move { handler.delete_archived_link(link).await }
            })
            .buffer_unordered(8)
            .collect::<Vec<_>>()
            .await;
        let deleted_count = results
            .iter()
            .filter(|result| result["deleted"] == true)
            .count();

        Ok(json!({
            "success": true,
            "accepted": true,
            "requestedCount": results.len(),
            "acceptedCount": deleted_count,
            "deletedCount": deleted_count,
            "results": results,
        }))
    }

    pub(super) async fn preview_archived_conversation_cleanup(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let links = self.archived_cleanup_links(&payload).await?;
        let previews = links
            .iter()
            .map(cleanup_task_files_preview)
            .collect::<Vec<_>>();
        Ok(cleanup_summary_response(previews, false))
    }

    pub(super) async fn cleanup_archived_conversations(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let links = self.archived_cleanup_links(&payload).await?;
        let results = links
            .iter()
            .map(|link| cleanup_task_files_response(link, true, false))
            .collect::<Vec<_>>();
        Ok(cleanup_summary_response(results, true))
    }
}
