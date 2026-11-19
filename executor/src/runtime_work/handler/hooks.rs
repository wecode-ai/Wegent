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

pub(super) fn hook_model_identity(request: &ExecutionRequest) -> (Option<String>, Option<String>) {
    let config = &request.model_config;
    (
        string_field(config, "model_id"),
        string_field(config, "model_provider"),
    )
}

pub(super) fn resolved_codex_hook_request(
    request: &ExecutionRequest,
    model: Option<String>,
    provider: Option<String>,
) -> ExecutionRequest {
    let mut request = request.clone();
    // Match the legacy rollout Hook's turn_context.model, including proxy models.
    // This copy is metadata only; it must never change the inference request.
    if let Some(model) = model {
        request.model_config["model_id"] = json!(model);
    }
    if let Some(provider) = provider {
        request.model_config["model_provider"] = json!(provider);
    }
    request
}

fn lifecycle_input(
    request: &ExecutionRequest,
    runtime_task_id: &str,
    device_id: &str,
    runtime: &str,
) -> Option<LifecycleInput> {
    let (model, model_provider) = hook_model_identity(request);
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
        model,
        model_provider,
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
        let input = lifecycle_input(request, runtime_task_id, &self.device_id, runtime)?;
        super::log_executor_event(
            "runtime lifecycle hook context created",
            &[
                ("local_task_id", runtime_task_id.into()),
                ("execution_id", input.execution_id.clone()),
                ("runtime", runtime.into()),
                ("model", input.model.clone().unwrap_or_default()),
                (
                    "model_provider",
                    input.model_provider.clone().unwrap_or_default(),
                ),
            ],
        );
        Some(LifecycleHooks::new(self.hook_service.clone(), input))
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
    fn native_hook_uses_the_resolved_thread_model_and_provider() {
        let request = ExecutionRequest {
            model_config: json!({}),
            ..Default::default()
        };
        let resolved = resolved_codex_hook_request(
            &request,
            Some("actual-native-model".into()),
            Some("native-provider".into()),
        );
        assert_eq!(
            hook_model_identity(&resolved),
            (
                Some("actual-native-model".into()),
                Some("native-provider".into())
            )
        );
        assert_eq!(request.model_config, json!({}));
        for kind in [
            "codex-official",
            "codex-provider",
            "cloud",
            "model-interface",
        ] {
            let mut native = request.clone();
            native.model_config["wework_model_kind"] = json!(kind);
            let resolved = resolved_codex_hook_request(
                &native,
                Some("actual-native-model".into()),
                Some("native-provider".into()),
            );
            assert_eq!(
                hook_model_identity(&resolved).0.as_deref(),
                Some("actual-native-model")
            );
        }
    }

    #[test]
    fn cloud_proxy_hook_matches_the_native_model_reported_by_legacy_rollouts() {
        // The gateway resource is not the model recorded by Codex, and the
        // authorized catalog may omit modelId.
        let request = ExecutionRequest {
            project_workspace_path: Some("/metadata-only-workspace".into()),
            model_config: json!({"wework_model_kind":"cloud",
                "model_id":"proxy-resource-label",
                "codex_responses_compat_proxy":true,
                "upstream_model_id":null, "upstream_model_provider":null}),
            ..Default::default()
        };
        let original_config = request.model_config.clone();
        let resolved = resolved_codex_hook_request(
            &request,
            Some("proxy-runtime-model".into()),
            Some("openai".into()),
        );
        let input = lifecycle_input(&resolved, "local-task", "device", "Codex").unwrap();
        assert_eq!(input.model.as_deref(), Some("proxy-runtime-model"));
        assert_eq!(input.model_provider.as_deref(), Some("openai"));
        assert_eq!(request.model_config, original_config);
        // Missing native fields must not erase explicitly configured metadata.
        let unchanged = resolved_codex_hook_request(&resolved, None, None);
        assert_eq!(
            hook_model_identity(&unchanged),
            hook_model_identity(&resolved)
        );
    }

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
