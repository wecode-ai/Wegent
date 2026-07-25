// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn upsert_local_project(&self, payload: Value) -> Result<Value, AppIpcError> {
        if !payload_runtime_is_codex(&payload) {
            return Ok(json!({
                "success": false,
                "accepted": false,
                "error": "Only Codex local projects support multiple roots",
                "code": "unsupported_runtime",
            }));
        }
        let project_key = string_field(&payload, "projectKey")
            .or_else(|| string_field(&payload, "project_key"))
            .ok_or_else(|| AppIpcError::new("bad_request", "projectKey is required"))?;
        let name = string_field(&payload, "name")
            .ok_or_else(|| AppIpcError::new("bad_request", "name is required"))?;
        let roots = payload
            .get("roots")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|root| !root.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if roots.is_empty() {
            return Err(AppIpcError::new(
                "bad_request",
                "roots must contain at least one workspace path",
            ));
        }
        for root in &roots {
            let canonical = fs::canonicalize(root).map_err(|_| {
                AppIpcError::new(
                    "bad_request",
                    format!("workspace root does not exist: {root}"),
                )
            })?;
            if !canonical.is_dir() {
                return Err(AppIpcError::new(
                    "bad_request",
                    format!("workspace root is not a directory: {root}"),
                ));
            }
            if let Ok(mut opened_roots) = self.opened_workspace_roots.lock() {
                opened_roots.insert(canonical);
            }
        }
        let project = upsert_codex_global_local_project(&project_key, &name, &roots)
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": self.device_id,
            "projectKey": project.key,
            "name": project.name,
            "roots": project.roots,
            "runtime": "codex",
        }))
    }

    pub(super) async fn open_workspace(&self, payload: Value) -> Result<Value, AppIpcError> {
        if !payload_runtime_is_codex(&payload) {
            return Ok(json!({
                "success": false,
                "error": "Only Codex runtime workspaces can be opened without a turn",
                "code": "unsupported_runtime",
            }));
        }
        let workspace_path = workspace_path(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let label = string_field(&payload, "label").or_else(|| string_field(&payload, "name"));
        let canonical = fs::canonicalize(&workspace_path).ok();
        if let Some(canonical) = canonical.as_ref() {
            if let Ok(mut roots) = self.opened_workspace_roots.lock() {
                roots.insert(canonical.clone());
            }
        }
        let project = match open_codex_global_project(&workspace_path, label.as_deref()) {
            Ok(project) => project,
            Err(error) => {
                if let Some(canonical) = canonical.as_ref() {
                    if let Ok(mut roots) = self.opened_workspace_roots.lock() {
                        roots.remove(canonical);
                    }
                }
                return Err(AppIpcError::new("codex_global_state_error", error));
            }
        };

        Ok(json!({
            "success": true,
            "accepted": true,
            "workspacePath": project.workspace_path,
            "runtime": "codex",
        }))
    }

    pub(super) async fn rename_workspace(&self, payload: Value) -> Result<Value, AppIpcError> {
        if !payload_runtime_is_codex(&payload) {
            return Ok(json!({
                "success": false,
                "error": "Only Codex runtime workspaces can be renamed without a turn",
                "code": "unsupported_runtime",
            }));
        }
        let workspace_path = workspace_path(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let label = string_field(&payload, "label")
            .or_else(|| string_field(&payload, "name"))
            .ok_or_else(|| AppIpcError::new("bad_request", "label is required"))?;
        let project_key =
            string_field(&payload, "projectKey").or_else(|| string_field(&payload, "project_key"));
        let project = rename_codex_global_project(project_key.as_deref(), &workspace_path, &label)
            .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;

        Ok(json!({
            "success": true,
            "accepted": true,
            "workspacePath": project.workspace_path,
            "runtime": "codex",
        }))
    }

    pub(super) async fn remove_workspace(&self, payload: Value) -> Result<Value, AppIpcError> {
        if !payload_runtime_is_codex(&payload) {
            return Ok(json!({
                "success": false,
                "error": "Only Codex runtime workspaces can be removed without a turn",
                "code": "unsupported_runtime",
            }));
        }
        let workspace_path = workspace_path(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let project_key =
            string_field(&payload, "projectKey").or_else(|| string_field(&payload, "project_key"));
        let workspace_path =
            remove_codex_global_project(project_key.as_deref(), &workspace_path)
                .map_err(|error| AppIpcError::new("codex_global_state_error", error))?;
        if let Ok(canonical) = fs::canonicalize(&workspace_path) {
            if let Ok(mut roots) = self.opened_workspace_roots.lock() {
                roots.remove(&canonical);
            }
        }

        Ok(json!({
            "success": true,
            "accepted": true,
            "workspacePath": workspace_path,
            "runtime": "codex",
        }))
    }
}
