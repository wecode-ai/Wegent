// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    time::Duration,
};

use serde_json::{json, Value};
use tokio::{process::Command, time::timeout};

const EXTENSION_TIMEOUT: Duration = Duration::from_secs(60);

pub trait DeviceExtensionHandler: Send + Sync + 'static {
    fn handle_run_extension<'a>(
        &'a self,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Value> + Send + 'a>>;
}

#[derive(Clone)]
pub struct DeviceExtensionRunner {
    workspace_root: PathBuf,
}

impl DeviceExtensionRunner {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self { workspace_root }
    }

    async fn run(&self, payload: Value) -> Value {
        match self.run_checked(payload).await {
            Ok(response) => response,
            Err(message) => json!({
                "success": false,
                "message": message,
            }),
        }
    }

    async fn run_checked(&self, payload: Value) -> Result<Value, String> {
        let extension_name = validate_name(
            "extension_name",
            payload.get("extension_name"),
            valid_extension_name,
        )?;
        let action = validate_name("action", payload.get("action"), valid_extension_action)?;
        let task_id = payload
            .get("task_id")
            .and_then(Value::as_i64)
            .filter(|task_id| *task_id > 0)
            .ok_or_else(|| "task_id must be a positive integer".to_owned())?;
        let script_path = validate_script_path(payload.get("script_path"))?;
        let extension_payload = payload.get("payload").cloned().unwrap_or_else(|| json!({}));
        if !extension_payload.is_object() {
            return Err("payload must be an object".to_owned());
        }

        let script =
            resolve_script_path(&self.workspace_root, task_id, &extension_name, &script_path)?;
        let output = run_script(&script, &action, &extension_name, &extension_payload).await?;
        let response: Value = serde_json::from_str(&output)
            .map_err(|error| format!("Extension returned invalid JSON: {error}"))?;
        if response.is_object() {
            Ok(response)
        } else {
            Err("Extension response must be a JSON object".to_owned())
        }
    }
}

impl DeviceExtensionHandler for DeviceExtensionRunner {
    fn handle_run_extension<'a>(
        &'a self,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Value> + Send + 'a>> {
        Box::pin(async move { self.run(payload).await })
    }
}

pub(super) fn default_extension_handler(workspace_root: PathBuf) -> DeviceExtensionRunner {
    DeviceExtensionRunner::new(workspace_root)
}

async fn run_script(
    script: &Path,
    action: &str,
    extension_name: &str,
    payload: &Value,
) -> Result<String, String> {
    let payload_json = serde_json::to_string(payload).unwrap_or_else(|_| "{}".to_owned());
    let mut command = Command::new("bash");
    command
        .arg(script)
        .arg(action)
        .kill_on_drop(true)
        .env("WEGENT_EXTENSION_NAME", extension_name)
        .env("WEGENT_EXTENSION_ACTION", action)
        .env("WEGENT_EXTENSION_PAYLOAD", &payload_json);

    if let Some(object) = payload.as_object() {
        for (key, value) in object {
            command.env(
                format!("WEGENT_EXT_{}", normalize_env_key(key)),
                env_value(value),
            );
        }
    }

    let output = timeout(EXTENSION_TIMEOUT, command.output())
        .await
        .map_err(|_| "Extension timed out".to_owned())?
        .map_err(|error| format!("Failed to run extension: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            if stdout.is_empty() {
                format!(
                    "Extension exited with code {}",
                    output.status.code().unwrap_or(-1)
                )
            } else {
                stdout
            }
        } else {
            stderr
        });
    }
    if stdout.is_empty() {
        return Err("Extension produced empty output".to_owned());
    }
    Ok(stdout)
}

fn resolve_script_path(
    workspace_root: &Path,
    task_id: i64,
    extension_name: &str,
    script_path: &str,
) -> Result<PathBuf, String> {
    let extension_dir = workspace_root
        .join(task_id.to_string())
        .join(".claude")
        .join("skills")
        .join(extension_name);
    let resolved_script = extension_dir.join(script_path);
    if !resolved_script.is_file() {
        return Err(format!(
            "Extension script not found: {}",
            resolved_script.display()
        ));
    }
    let extension_dir = extension_dir
        .canonicalize()
        .map_err(|error| format!("Extension directory is invalid: {error}"))?;
    let resolved_script = resolved_script
        .canonicalize()
        .map_err(|error| format!("Extension script is invalid: {error}"))?;
    if !resolved_script.starts_with(&extension_dir) {
        return Err(format!(
            "Script path escapes extension directory: {script_path}"
        ));
    }
    Ok(resolved_script)
}

fn validate_name(
    field: &str,
    value: Option<&Value>,
    validator: fn(char) -> bool,
) -> Result<String, String> {
    let value = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{field} is required"))?;
    if value.chars().all(validator) {
        Ok(value.to_owned())
    } else {
        Err(format!("Invalid {field}: {value}"))
    }
}

fn validate_script_path(value: Option<&Value>) -> Result<String, String> {
    let value = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "script_path is required".to_owned())?
        .trim_start_matches('/');
    if !value.chars().all(valid_script_path) || value.starts_with("../") || value.contains("/../") {
        return Err(format!("Invalid script_path: {value}"));
    }
    Ok(value.to_owned())
}

fn valid_extension_name(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
}

fn valid_extension_action(character: char) -> bool {
    valid_extension_name(character)
}

fn valid_script_path(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-' | '/')
}

fn normalize_env_key(key: &str) -> String {
    let normalized = key
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_owned();
    if normalized.is_empty() {
        "VALUE".to_owned()
    } else {
        normalized
    }
}

fn env_value(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}
