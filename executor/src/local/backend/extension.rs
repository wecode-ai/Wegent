// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use serde_json::{json, Value};
use tokio::{process::Command, time::timeout};

const EXTENSION_TIMEOUT: Duration = Duration::from_secs(60);

type TaskSkillsResolver = dyn Fn(&str, &str, &str) -> Result<PathBuf, String> + Send + Sync;

#[derive(Clone)]
enum BackendIdentity {
    Authenticated {
        backend_url: String,
        user_id: String,
    },
    Connection {
        backend_url: String,
        auth_token: String,
    },
}

pub trait DeviceExtensionHandler: Send + Sync + 'static {
    fn handle_run_extension<'a>(
        &'a self,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Value> + Send + 'a>>;
}

#[derive(Clone)]
pub struct DeviceExtensionRunner {
    task_skills_resolver: Arc<TaskSkillsResolver>,
    global_skills_root: PathBuf,
    backend_identity: Option<BackendIdentity>,
}

impl DeviceExtensionRunner {
    pub fn new() -> Self {
        let runtime_home = env::var("HOME")
            .or_else(|_| env::var("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."));
        let claude_home = env::var_os("WEGENT_CLAUDE_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| runtime_home.join(".claude"));
        Self::with_global_skills_root(claude_home.join("skills"))
    }

    pub fn with_global_skills_root(global_skills_root: PathBuf) -> Self {
        Self {
            task_skills_resolver: Arc::new(crate::agents::task_skills_directory),
            global_skills_root,
            backend_identity: None,
        }
    }

    pub fn with_task_skills_resolver<F>(mut self, resolver: F) -> Self
    where
        F: Fn(&str, &str, &str) -> Result<PathBuf, String> + Send + Sync + 'static,
    {
        self.task_skills_resolver = Arc::new(resolver);
        self
    }

    /// Bind only identity obtained by the transport, never extension payload fields.
    pub fn with_authenticated_identity(mut self, backend_url: String, user_id: String) -> Self {
        self.backend_identity = Some(BackendIdentity::Authenticated {
            backend_url,
            user_id,
        });
        self
    }

    pub fn with_backend_connection(mut self, backend_url: String, auth_token: String) -> Self {
        self.backend_identity = Some(BackendIdentity::Connection {
            backend_url,
            auth_token,
        });
        self
    }

    pub fn with_workbench_root(self, root: PathBuf) -> Self {
        self.with_task_skills_resolver(move |task_id, backend_url, user_id| {
            crate::agents::task_skills_directory_at(&root, task_id, backend_url, user_id)
        })
    }

    async fn authenticated_identity(&self) -> Result<(String, String), String> {
        match self
            .backend_identity
            .as_ref()
            .ok_or("Task extension requires authenticated backend/user binding")?
        {
            BackendIdentity::Authenticated {
                backend_url,
                user_id,
            } => Ok((backend_url.clone(), user_id.clone())),
            BackendIdentity::Connection {
                backend_url,
                auth_token,
            } => {
                if auth_token.trim().is_empty() {
                    return Err("Task extension authentication is missing".to_owned());
                }
                // The existing extension event has no authenticated user field.
                // Resolve it using the same credential as the socket connection.
                let client = reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(10))
                    .build()
                    .map_err(|_| "Cannot initialize extension identity lookup")?;
                let response = client
                    .get(current_user_url(backend_url)?)
                    .bearer_auth(auth_token)
                    .send()
                    .await
                    .map_err(|_| "Cannot authenticate extension account")?
                    .error_for_status()
                    .map_err(|_| "Extension account authentication failed")?;
                let user: Value = response
                    .json()
                    .await
                    .map_err(|_| "Invalid extension account response")?;
                let id = user
                    .get("id")
                    .and_then(Value::as_u64)
                    .filter(|id| *id > 0)
                    .ok_or("Extension account response has no valid user identity")?;
                Ok((backend_url.clone(), id.to_string()))
            }
        }
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
        let extension_scope = validate_extension_scope(payload.get("extension_scope"))?;
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

        let skills_root = if extension_scope == "global" {
            self.global_skills_root.clone()
        } else {
            let (backend_url, user_id) = self.authenticated_identity().await?;
            (self.task_skills_resolver)(&task_id.to_string(), &backend_url, &user_id)?
        };
        let script = resolve_script_path(&skills_root, &extension_name, &script_path)?;
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

impl Default for DeviceExtensionRunner {
    fn default() -> Self {
        Self::new()
    }
}

pub(super) fn default_extension_handler() -> DeviceExtensionRunner {
    DeviceExtensionRunner::new()
}

fn current_user_url(backend_url: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(backend_url).map_err(|_| "Invalid extension backend URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid extension backend URL".to_owned());
    }
    let path = url.path().trim_end_matches('/');
    let api = if path.ends_with("/api/v1") || path.ends_with("/api") {
        path.to_owned()
    } else {
        format!("{path}/api")
    };
    url.set_path(&format!("{api}/users/me"));
    Ok(url)
}

async fn run_script(
    script: &Path,
    action: &str,
    extension_name: &str,
    payload: &Value,
) -> Result<String, String> {
    let payload_json = serde_json::to_string(payload).unwrap_or_else(|_| "{}".to_owned());
    let mut command = Command::new("bash");
    crate::process::hide_windows_console(&mut command);
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
    skills_root: &Path,
    extension_name: &str,
    script_path: &str,
) -> Result<PathBuf, String> {
    let extension_dir = skills_root.join(extension_name);
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

fn validate_extension_scope(value: Option<&Value>) -> Result<String, String> {
    let value = value
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("task");
    match value {
        "global" | "task" => Ok(value.to_owned()),
        _ => Err(format!("Invalid extension_scope: {value}")),
    }
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
    if matches!(value, "." | "..") {
        return Err(format!("Invalid {field}: {value}"));
    }
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

#[cfg(test)]
mod identity_url_tests {
    use super::current_user_url;

    #[test]
    fn connection_urls_preserve_explicit_api_prefixes() {
        for (base, path) in [
            ("https://backend.example", "/api/users/me"),
            ("https://backend.example/api", "/api/users/me"),
            ("https://backend.example/api/v1/", "/api/v1/users/me"),
            (
                "https://backend.example/prefix/api/v1",
                "/prefix/api/v1/users/me",
            ),
        ] {
            assert_eq!(current_user_url(base).unwrap().path(), path);
        }
        assert!(current_user_url("https://user:secret@backend.example").is_err());
    }
}
