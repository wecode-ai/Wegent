// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
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

    pub(super) async fn restart_codex_app_server(&self) -> Result<Value, AppIpcError> {
        self.codex_app_server.restart().await;
        self.thread_list_cache.invalidate();
        Ok(json!({ "restarted": true }))
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

    pub(super) async fn list_codex_models(&self, payload: Value) -> Result<Value, AppIpcError> {
        let include_hidden = bool_field(&payload, "includeHidden")
            .or_else(|| bool_field(&payload, "include_hidden"));
        let limit = integer_field(&payload, "limit")
            .filter(|value| *value > 0)
            .map(|value| value as u32);
        let cursor = string_field(&payload, "cursor");
        let model_list_params = json!({
            "limit": limit,
            "cursor": cursor,
            "includeHidden": include_hidden,
        });
        let config = self
            .codex_app_server
            .request(
                "config/read",
                json!({
                    "includeLayers": false,
                    "cwd": Value::Null,
                }),
            )
            .await
            .map_err(|error| AppIpcError::new("codex_models_unavailable", error))?;
        let provider = current_codex_model_provider_from_config(&config);
        let (available, error, models) = match self
            .codex_app_server
            .request("model/list", model_list_params)
            .await
        {
            Ok(response) => (
                true,
                Value::Null,
                codex_models_with_provider(&response, &provider),
            ),
            Err(error) => (false, Value::String(error), Vec::new()),
        };
        let provider_results = vec![json!({
            "id": provider.id,
            "displayName": provider.display_name,
            "type": provider.kind,
            "current": provider.current,
            "available": available,
            "error": error,
            "data": models.clone(),
        })];
        Ok(json!({
            "data": models,
            "providers": provider_results,
        }))
    }

    pub(super) async fn read_codex_instructions(&self) -> Result<Value, AppIpcError> {
        let response = self
            .codex_app_server
            .request(
                "config/read",
                json!({
                    "includeLayers": false,
                    "cwd": Value::Null,
                }),
            )
            .await
            .map_err(|error| AppIpcError::new("codex_instructions_read_failed", error))?;
        let config = response.get("config").unwrap_or(&Value::Null);
        let developer_instructions = config
            .get("developer_instructions")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let user_developer_instructions = strip_wework_browser_instructions(developer_instructions);
        let legacy_instructions = config
            .get("instructions")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let instructions =
            if user_developer_instructions.is_empty() && !legacy_instructions.trim().is_empty() {
                self.write_codex_developer_instructions(legacy_instructions)
                    .await?;
                legacy_instructions
            } else {
                user_developer_instructions
            };
        Ok(json!({ "instructions": instructions }))
    }

    pub(super) async fn write_codex_instructions(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let Some(instructions) = payload.get("instructions") else {
            return Err(AppIpcError::new(
                "invalid_request",
                "instructions must be a string",
            ));
        };
        let Some(instructions) = instructions.as_str() else {
            return Err(AppIpcError::new(
                "invalid_request",
                "instructions must be a string",
            ));
        };
        let response = self
            .write_codex_developer_instructions(instructions)
            .await?;
        Ok(json!({
            "instructions": instructions.trim(),
            "configPath": response.get("filePath").cloned().unwrap_or(Value::Null),
        }))
    }

    pub(super) async fn write_codex_developer_instructions(
        &self,
        instructions: &str,
    ) -> Result<Value, AppIpcError> {
        let value = Value::String(combined_codex_developer_instructions(instructions));
        self.codex_app_server
            .request(
                "config/batchWrite",
                json!({
                    "edits": [
                        {
                            "keyPath": "developer_instructions",
                            "value": value,
                            "mergeStrategy": "replace",
                        },
                        {
                            "keyPath": "instructions",
                            "value": Value::Null,
                            "mergeStrategy": "replace",
                        }
                    ],
                    "filePath": Value::Null,
                    "expectedVersion": Value::Null,
                    "reloadUserConfig": true,
                }),
            )
            .await
            .map_err(|error| AppIpcError::new("codex_instructions_write_failed", error))
    }

    pub(super) async fn read_codex_personality(&self) -> Result<Value, AppIpcError> {
        let response = self
            .codex_app_server
            .request(
                "config/read",
                json!({
                    "includeLayers": false,
                    "cwd": Value::Null,
                }),
            )
            .await
            .map_err(|error| AppIpcError::new("codex_personality_read_failed", error))?;
        let personality = response
            .get("config")
            .and_then(|config| config.get("personality"))
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "friendly" | "pragmatic"))
            .unwrap_or("pragmatic");
        Ok(json!({ "personality": personality }))
    }

    pub(super) async fn write_codex_personality(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let personality = payload
            .get("personality")
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "friendly" | "pragmatic"))
            .ok_or_else(|| {
                AppIpcError::new(
                    "invalid_request",
                    "personality must be friendly or pragmatic",
                )
            })?;
        let response = self
            .codex_app_server
            .request(
                "config/batchWrite",
                json!({
                    "edits": [{
                        "keyPath": "personality",
                        "value": personality,
                        "mergeStrategy": "replace",
                    }],
                    "filePath": Value::Null,
                    "expectedVersion": Value::Null,
                    "reloadUserConfig": true,
                }),
            )
            .await
            .map_err(|error| AppIpcError::new("codex_personality_write_failed", error))?;
        Ok(json!({
            "personality": personality,
            "configPath": response.get("filePath").cloned().unwrap_or(Value::Null),
        }))
    }

    pub(super) async fn read_codex_rate_limits(&self) -> Result<Value, AppIpcError> {
        self.codex_app_server
            .request("account/rateLimits/read", Value::Null)
            .await
            .map_err(|error| AppIpcError::new("codex_rate_limits_unavailable", error))
    }
}
