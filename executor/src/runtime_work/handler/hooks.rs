// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{env, path::Path, path::PathBuf};

use serde_json::{json, Value};

use crate::{
    hooks::{
        lifecycle::LifecycleHooks,
        model::{HookEventName, HookPluginManifest, HooksConfig, LifecycleInput},
    },
    local::app_ipc::AppIpcError,
    protocol::ExecutionRequest,
};

use super::{hook_payload, hook_rpc_error, string_field, RuntimeWorkRpcHandler};

pub(super) fn lifecycle_status(outcome: &crate::runner::ExecutionOutcome) -> &'static str {
    use crate::runner::ExecutionOutcome;
    match outcome {
        ExecutionOutcome::Completed { .. } => "completed",
        ExecutionOutcome::Cancelled { .. } => "interrupted",
        ExecutionOutcome::Failed { .. } => "failed",
        ExecutionOutcome::WaitingForUserInput { .. } => "waiting_for_user_input",
        ExecutionOutcome::Running => "running",
    }
}

fn lifecycle_input(
    request: &ExecutionRequest,
    runtime_task_id: &str,
    device_id: &str,
    runtime: &str,
) -> Option<LifecycleInput> {
    Some(LifecycleInput {
        schema_version: 1,
        emitted_at_ms: 0,
        event_id: String::new(),
        execution_id: uuid::Uuid::new_v4().to_string(),
        sequence: 0,
        task_id: Some(request.task_id.clone()).filter(|value| !value.is_empty()),
        request_id: Some(request.subtask_id.clone()).filter(|value| !value.is_empty()),
        runtime_task_id: Some(runtime_task_id.into()),
        device_id: Some(device_id.into()),
        runtime: Some(runtime.into()),
        executor_version: Some(env!("CARGO_PKG_VERSION").into()),
        platform: env::consts::OS.into(),
        arch: env::consts::ARCH.into(),
        user: super::turns::hook_user(request),
        cwd: PathBuf::from(request.cwd()?),
        session_id: None,
        turn_id: None,
        model: string_field(&request.model_config, "model_id"),
        model_provider: string_field(&request.model_config, "model_provider"),
        permission_mode: "workspace-write".into(),
        hook_event_name: HookEventName::TurnStarted,
        status: "started".into(),
        is_test: false,
    })
}

impl RuntimeWorkRpcHandler {
    pub(super) fn begin_lifecycle_hooks(
        &self,
        request: &ExecutionRequest,
        runtime_task_id: &str,
        runtime: &str,
    ) -> Option<LifecycleHooks> {
        Some(LifecycleHooks::new(
            self.hook_service.clone(),
            lifecycle_input(request, runtime_task_id, &self.device_id, runtime)?,
        ))
    }

    pub(super) async fn create_hook(&self, payload: Value) -> Result<Value, AppIpcError> {
        let manifest = hook_payload::<HookPluginManifest>(&payload, "manifest")?;
        let config = hook_payload::<HooksConfig>(&payload, "hooks")?;
        let plugin = self
            .hook_service
            .registry()
            .create(manifest, config)
            .map_err(hook_rpc_error)?;
        self.emit_hooks_changed(&plugin.manifest.id);
        Ok(json!({"plugin": plugin}))
    }

    pub(super) async fn install_hook(&self, payload: Value) -> Result<Value, AppIpcError> {
        let path = string_field(&payload, "path")
            .ok_or_else(|| AppIpcError::new("bad_request", "path is required"))?;
        let plugin = self
            .hook_service
            .registry()
            .install(Path::new(&path))
            .map_err(hook_rpc_error)?;
        self.emit_hooks_changed(&plugin.manifest.id);
        Ok(json!({"plugin": plugin}))
    }

    pub(super) async fn update_hook(&self, payload: Value) -> Result<Value, AppIpcError> {
        let id = string_field(&payload, "pluginId")
            .or_else(|| string_field(&payload, "plugin_id"))
            .ok_or_else(|| AppIpcError::new("bad_request", "pluginId is required"))?;
        let manifest = hook_payload::<HookPluginManifest>(&payload, "manifest")?;
        let config = hook_payload::<HooksConfig>(&payload, "hooks")?;
        let plugin = self
            .hook_service
            .registry()
            .update(&id, manifest, config)
            .map_err(hook_rpc_error)?;
        self.emit_hooks_changed(&id);
        Ok(json!({"plugin": plugin}))
    }

    pub(super) async fn set_hook_enabled(&self, payload: Value) -> Result<Value, AppIpcError> {
        let id = string_field(&payload, "pluginId")
            .or_else(|| string_field(&payload, "plugin_id"))
            .ok_or_else(|| AppIpcError::new("bad_request", "pluginId is required"))?;
        let enabled = payload
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| AppIpcError::new("bad_request", "enabled is required"))?;
        let plugin = self
            .hook_service
            .registry()
            .set_enabled(&id, enabled)
            .map_err(hook_rpc_error)?;
        self.emit_hooks_changed(&id);
        Ok(json!({"plugin": plugin}))
    }

    pub(super) async fn delete_hook(&self, payload: Value) -> Result<Value, AppIpcError> {
        let id = string_field(&payload, "pluginId")
            .or_else(|| string_field(&payload, "plugin_id"))
            .ok_or_else(|| AppIpcError::new("bad_request", "pluginId is required"))?;
        self.hook_service
            .registry()
            .delete(&id)
            .map_err(hook_rpc_error)?;
        self.emit_hooks_changed(&id);
        Ok(json!({"success": true, "pluginId": id}))
    }

    pub(super) async fn reveal_hook(&self, payload: Value) -> Result<Value, AppIpcError> {
        let id = string_field(&payload, "pluginId")
            .or_else(|| string_field(&payload, "plugin_id"))
            .ok_or_else(|| AppIpcError::new("bad_request", "pluginId is required"))?;
        self.hook_service
            .list()
            .into_iter()
            .find(|plugin| plugin.manifest.id == id)
            .map(|plugin| json!({"path": plugin.install_path}))
            .ok_or_else(|| AppIpcError::new("not_found", "hook plugin not found"))
    }

    pub(super) async fn test_hook(&self, payload: Value) -> Result<Value, AppIpcError> {
        let plugin_id = string_field(&payload, "pluginId")
            .or_else(|| string_field(&payload, "plugin_id"))
            .ok_or_else(|| AppIpcError::new("bad_request", "pluginId is required"))?;
        let handler_id = string_field(&payload, "handlerId")
            .or_else(|| string_field(&payload, "handler_id"))
            .ok_or_else(|| AppIpcError::new("bad_request", "handlerId is required"))?;
        let cwd = string_field(&payload, "cwd")
            .map(PathBuf::from)
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        self.hook_service
            .test(&plugin_id, &handler_id, cwd)
            .await
            .map(|run| json!({"run": run}))
            .map_err(hook_rpc_error)
    }

    fn emit_hooks_changed(&self, plugin_id: &str) {
        if let Some(sender) = &self.event_tx {
            let _ = sender
                .send(json!({"event":"runtime.hooks.changed","payload":{"pluginId":plugin_id}}));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_metadata_preserves_identity_and_excludes_credentials() {
        let request: ExecutionRequest = serde_json::from_value(json!({
            "task_id": "backend-task", "subtask_id": "source-request",
            "project_workspace_path": "/nonexistent-metadata-only-workspace",
            "user_id": 42, "user_name": "report-user", "device_id": "request-device",
            "model_config": {"model_id": "test-model", "model_provider": "test-provider", "api_key": "secret-model-key"},
            "auth_token": "secret-auth", "runtime_auth_token": "secret-runtime",
            "skill_identity_token": "secret-skill", "prompt": "private-prompt",
            "extra_secret": "secret-extra",
        })).unwrap();
        for runtime in ["Codex", "ClaudeCode"] {
            let input = lifecycle_input(&request, "local-task", "actual-device", runtime).unwrap();
            assert_eq!(input.task_id.as_deref(), Some("backend-task"));
            assert_eq!(input.request_id.as_deref(), Some("source-request"));
            assert_eq!(input.runtime_task_id.as_deref(), Some("local-task"));
            assert_eq!(input.device_id.as_deref(), Some("actual-device"));
            assert_eq!(input.runtime.as_deref(), Some(runtime));
            assert_eq!(input.user.id.as_deref(), Some("42"));
            assert_eq!(input.user.name, "report-user");
            assert_eq!(input.model.as_deref(), Some("test-model"));
            assert_eq!(input.model_provider.as_deref(), Some("test-provider"));
            assert_eq!(
                input.executor_version.as_deref(),
                Some(env!("CARGO_PKG_VERSION"))
            );
            let serialized = serde_json::to_string(&input).unwrap();
            assert!(!serialized.contains("secret-"));
            assert!(!serialized.contains("private-prompt"));
        }
        let empty = ExecutionRequest::default();
        assert!(lifecycle_input(&empty, "local-task", "device", "Codex").is_none());
        let unspecified = ExecutionRequest {
            project_workspace_path: Some("/metadata-only-workspace".into()),
            ..Default::default()
        };
        let input = lifecycle_input(&unspecified, "local-task", "device", "Codex").unwrap();
        assert!(input.model.is_none());
        assert!(input.model_provider.is_none());
        assert!(input.task_id.is_none());
        assert!(input.request_id.is_none());
        assert!(input.user.id.is_none());
    }
}
