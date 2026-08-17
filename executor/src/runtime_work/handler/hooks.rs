// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{env, path::Path, path::PathBuf};

use serde_json::{json, Value};

use crate::{
    hooks::model::{HookPluginManifest, HooksConfig},
    local::app_ipc::AppIpcError,
};

use super::{hook_payload, hook_rpc_error, string_field, RuntimeWorkRpcHandler};

impl RuntimeWorkRpcHandler {
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
