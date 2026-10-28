// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::runtime_work::util::infer_worktree_id;
use sha2::{Digest, Sha256};

pub(super) const DEFERRED_ENVIRONMENT: &str = "deferred_project_environment";

pub(super) fn configure(
    request: &mut ExecutionRequest,
    payload: &Value,
) -> Result<bool, AppIpcError> {
    let Some(mut definition) = payload
        .pointer("/execution/environment")
        .filter(|v| v.is_object())
        .cloned()
    else {
        return Ok(false);
    };
    if payload
        .get("workspaceSourceTask")
        .is_some_and(|v| !v.is_null())
    {
        return Ok(false);
    }
    let id = definition["environmentId"]
        .as_str()
        .ok_or_else(|| AppIpcError::new("invalid_environment", "Project identity is required"))?
        .to_owned();
    let fingerprint = definition["fingerprint"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let config = json!({
                "repositories": definition["repositories"],
                "setupSteps": definition["setupSteps"],
            });
            format!("{:x}", Sha256::digest(config.to_string().as_bytes()))
        });
    definition["environmentId"] = json!(format!(
        "{id}-{}",
        fingerprint.chars().take(12).collect::<String>()
    ));
    definition["fingerprint"] = json!(fingerprint);
    let path = crate::local::environment_prepare::environment_workspace_path(&definition)
        .map_err(|e| AppIpcError::new("invalid_environment", e))?;
    request.project_workspace_path = Some(path);
    request.workspace_source = payload
        .pointer("/execution/workspace/source")
        .and_then(Value::as_str)
        .map(str::to_owned);
    request
        .extra
        .insert(DEFERRED_ENVIRONMENT.into(), definition);
    Ok(true)
}

pub(super) fn needs_preparation(turn: &SpawnTurnRequest) -> bool {
    turn.request.extra.contains_key("creation_branch")
        || turn.request.extra.contains_key(DEFERRED_ENVIRONMENT)
        || turn
            .request
            .extra
            .contains_key("deferred_worktree_source_path")
}

impl RuntimeWorkRpcHandler {
    pub(super) fn persist_prepared_project_workspace(
        &self,
        turn: &SpawnTurnRequest,
    ) -> Result<(), AppIpcError> {
        if turn
            .request
            .extra
            .get("origin")
            .and_then(|origin| origin.get("projectStore"))
            .and_then(Value::as_str)
            != Some("local")
        {
            return Ok(());
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(|error| {
            AppIpcError::new("project_workspace_persist_failed", error.to_string())
        })?;
        let execution = store
            .execution_by_runtime_task_id(&turn.local_task_id)
            .map_err(|error| {
                AppIpcError::new("project_workspace_persist_failed", error.to_string())
            })?;
        if let Some(execution) = execution {
            let path = turn.request.cwd().unwrap_or_default();
            store
                .update_execution_binding_runtime(
                    execution.id,
                    Some(&json!({
                        "runtime": turn.runtime,
                        "workspacePath": path,
                        "workspaceKind": infer_workspace_kind(path),
                        "worktreeId": infer_worktree_id(path),
                    })),
                    None,
                )
                .map_err(|error| {
                    AppIpcError::new("project_workspace_persist_failed", error.to_string())
                })?;
        }
        Ok(())
    }

    pub(super) async fn prepare_project_environment(
        &self,
        turn: &mut SpawnTurnRequest,
    ) -> Result<(), AppIpcError> {
        let Some(definition) = turn.request.extra.get(DEFERRED_ENVIRONMENT).cloned() else {
            return Ok(());
        };
        log_executor_event(
            "project preparation started",
            &[("local_task_id", turn.local_task_id.clone())],
        );
        let prepare = crate::local::environment_prepare::prepare_environment(&definition);
        tokio::pin!(prepare);
        let prepared = loop {
            let cancelled = self
                .preparing_worktree_turns
                .lock()
                .expect("preparation map poisoned")
                .get(&turn.local_task_id)
                .is_some_and(|p| p.cancellation_requested);
            if cancelled {
                return Err(AppIpcError::new(
                    "preparation_cancelled",
                    "Project preparation cancelled",
                ));
            }
            tokio::select! {
                result = &mut prepare => break result.map_err(|error| AppIpcError::new("project_preparation_failed", error))?,
                _ = sleep(Duration::from_millis(100)) => {}
            }
        };
        let path = prepared
            .cwd()
            .ok_or_else(|| {
                AppIpcError::new(
                    "project_preparation_failed",
                    "Project preparation returned no directory",
                )
            })?
            .to_owned();
        turn.request.project_workspace_path = Some(path.clone());
        turn.request.runtime_workspace_roots = prepared.runtime_workspace_roots;
        if turn.request.workspace_source.as_deref() == Some("git_worktree") {
            turn.request
                .extra
                .insert("deferred_worktree_source_path".into(), json!(path));
        }
        turn.request.extra.remove(DEFERRED_ENVIRONMENT);
        log_executor_event(
            "project preparation completed",
            &[("local_task_id", turn.local_task_id.clone())],
        );
        Ok(())
    }
}
