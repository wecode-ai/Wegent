// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

use crate::local::app_ipc::AppIpcError;

use super::{
    activate_codex_global_project, bool_field, reorder_codex_global_project_thread,
    reorder_codex_global_projects, set_codex_global_project_appearance,
    set_codex_global_project_pinned, set_codex_global_thread_pinned, sidebar_mutation_response,
    string_field, sync_codex_global_remote_projects, workspace_path, CodexGlobalRemoteProject,
    RuntimeWorkRpcHandler,
};

impl RuntimeWorkRpcHandler {
    pub(super) async fn reorder_sidebar_projects(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let project_key = string_field(&payload, "projectKey")
            .or_else(|| string_field(&payload, "project_key"))
            .ok_or_else(|| AppIpcError::new("bad_request", "projectKey is required"))?;
        let before_project_key = string_field(&payload, "beforeProjectKey")
            .or_else(|| string_field(&payload, "before_project_key"));
        let insert_at_end = bool_field(&payload, "insertAtEnd")
            .or_else(|| bool_field(&payload, "insert_at_end"))
            .unwrap_or(false);
        reorder_codex_global_projects(&project_key, before_project_key.as_deref(), insert_at_end)
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        Ok(sidebar_mutation_response(&self.device_id))
    }

    pub(super) async fn pin_sidebar_project(&self, payload: Value) -> Result<Value, AppIpcError> {
        let project_key = string_field(&payload, "projectKey")
            .or_else(|| string_field(&payload, "project_key"))
            .ok_or_else(|| AppIpcError::new("bad_request", "projectKey is required"))?;
        let pinned = bool_field(&payload, "pinned")
            .ok_or_else(|| AppIpcError::new("bad_request", "pinned is required"))?;
        let before_project_key = string_field(&payload, "beforeProjectKey")
            .or_else(|| string_field(&payload, "before_project_key"));
        set_codex_global_project_pinned(&project_key, pinned, before_project_key.as_deref())
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        Ok(sidebar_mutation_response(&self.device_id))
    }

    pub(super) async fn set_sidebar_project_appearance(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let project_key = string_field(&payload, "projectKey")
            .or_else(|| string_field(&payload, "project_key"))
            .ok_or_else(|| AppIpcError::new("bad_request", "projectKey is required"))?;
        let appearance = payload.get("appearance").cloned().filter(Value::is_object);
        set_codex_global_project_appearance(&project_key, appearance)
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        Ok(sidebar_mutation_response(&self.device_id))
    }

    pub(super) async fn sync_sidebar_remote_projects(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let items = payload
            .get("projects")
            .and_then(Value::as_array)
            .ok_or_else(|| AppIpcError::new("bad_request", "projects is required"))?;
        let projects = items
            .iter()
            .map(|item| {
                Ok(CodexGlobalRemoteProject {
                    id: string_field(item, "id").ok_or_else(|| {
                        AppIpcError::new("bad_request", "remote project id is required")
                    })?,
                    host_id: string_field(item, "hostId")
                        .or_else(|| string_field(item, "host_id"))
                        .ok_or_else(|| {
                            AppIpcError::new("bad_request", "remote project hostId is required")
                        })?,
                    remote_path: string_field(item, "remotePath")
                        .or_else(|| string_field(item, "remote_path"))
                        .ok_or_else(|| {
                            AppIpcError::new("bad_request", "remote project remotePath is required")
                        })?,
                    label: string_field(item, "label"),
                })
            })
            .collect::<Result<Vec<_>, AppIpcError>>()?;
        sync_codex_global_remote_projects(&projects)
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        Ok(sidebar_mutation_response(&self.device_id))
    }

    pub(super) async fn activate_sidebar_project(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let project_key = string_field(&payload, "projectKey")
            .or_else(|| string_field(&payload, "project_key"))
            .ok_or_else(|| AppIpcError::new("bad_request", "projectKey is required"))?;
        let workspace_path = workspace_path(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let remote_host_id = string_field(&payload, "remoteHostId")
            .or_else(|| string_field(&payload, "remote_host_id"));
        activate_codex_global_project(&project_key, &workspace_path, remote_host_id.as_deref())
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        Ok(sidebar_mutation_response(&self.device_id))
    }

    pub(super) async fn reorder_sidebar_project_task(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let project_key = string_field(&payload, "projectKey")
            .or_else(|| string_field(&payload, "project_key"))
            .ok_or_else(|| AppIpcError::new("bad_request", "projectKey is required"))?;
        let thread_id = string_field(&payload, "threadId")
            .or_else(|| string_field(&payload, "thread_id"))
            .ok_or_else(|| AppIpcError::new("bad_request", "threadId is required"))?;
        let before_thread_id = string_field(&payload, "beforeThreadId")
            .or_else(|| string_field(&payload, "before_thread_id"));
        let insert_at_end = bool_field(&payload, "insertAtEnd")
            .or_else(|| bool_field(&payload, "insert_at_end"))
            .unwrap_or(false);
        reorder_codex_global_project_thread(
            &project_key,
            &thread_id,
            before_thread_id.as_deref(),
            insert_at_end,
        )
        .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        Ok(sidebar_mutation_response(&self.device_id))
    }

    pub(super) async fn pin_sidebar_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let thread_id = string_field(&payload, "threadId")
            .or_else(|| string_field(&payload, "thread_id"))
            .ok_or_else(|| AppIpcError::new("bad_request", "threadId is required"))?;
        let pinned = bool_field(&payload, "pinned")
            .ok_or_else(|| AppIpcError::new("bad_request", "pinned is required"))?;
        let before_thread_id = string_field(&payload, "beforeThreadId")
            .or_else(|| string_field(&payload, "before_thread_id"));
        set_codex_global_thread_pinned(&thread_id, pinned, before_thread_id.as_deref())
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        Ok(sidebar_mutation_response(&self.device_id))
    }
}
