// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tokio::sync::Mutex as AsyncMutex;

use crate::{
    agents::git_auth::DEVICE_LOCAL, local::command::CommandResult, protocol::ExecutionRequest,
    workspace_paths::task_workspace_dir,
};

static PREPARATIONS: OnceLock<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>> = OnceLock::new();

fn preparation_lock(key: &str) -> Arc<AsyncMutex<()>> {
    let mut locks = PREPARATIONS
        .get_or_init(Default::default)
        .lock()
        .expect("preparation locks poisoned");
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(AsyncMutex::new(()));
    locks.insert(key.to_owned(), Arc::downgrade(&lock));
    lock
}

pub(crate) fn environment_workspace_path(definition: &Value) -> Result<String, String> {
    let id = definition["environmentId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("Execution environment identity is required")?;
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("Invalid execution environment identity".into());
    }
    if let Some(path) = definition["workspacePath"]
        .as_str()
        .filter(|p| !p.trim().is_empty())
    {
        return Ok(path.to_owned());
    }
    let mut path = task_workspace_dir(&format!("environment-{id}")).join("environment");
    if let Some(primary) = definition["repositories"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["primary"] == true)
    {
        let relative = primary["path"]
            .as_str()
            .ok_or("Primary repository directory is required")?;
        if relative.is_empty()
            || std::path::Path::new(relative)
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("Repository directory must be a normalized relative path".into());
        }
        path.push(relative);
    }
    Ok(path.display().to_string())
}

pub(crate) async fn prepare_environment(definition: &Value) -> Result<ExecutionRequest, String> {
    let path = environment_workspace_path(definition)?;
    let gate = preparation_lock(&path);
    let _guard = gate.lock().await;
    let mut request =
        build_prepare_request(definition["environmentId"].as_str().unwrap(), definition);
    if definition["workspacePath"]
        .as_str()
        .is_some_and(|p| !p.trim().is_empty())
    {
        if !std::path::Path::new(&path).is_dir() {
            return Err(format!("Prepared project directory is missing: {path}"));
        }
        request.project_workspace_path = Some(path.clone());
        request.runtime_workspace_roots = vec![path.clone()];
        request.skip_git_clone = true;
        let prepared = crate::agents::git_workspace::prepare_git_workspace(request).await?;
        if prepared.cwd() != Some(path.as_str()) {
            return Err(
                "Prepared project directory does not match its repository configuration".into(),
            );
        }
        return Ok(prepared);
    }
    if definition["repositories"]
        .as_array()
        .map_or(true, Vec::is_empty)
    {
        request = prepare_blank_workspace(request)?;
    }
    let _workspace_lease = crate::agents::git_workspace::acquire_execution_lease(&request)?;
    let prepared = crate::agents::git_workspace::prepare_git_workspace(request)
        .await
        .map_err(|error| format!("Failed to prepare project repositories: {error}"))?;
    crate::agents::environment_setup::prepare_execution_environment(&prepared)
        .await
        .map_err(|error| format!("Failed to run project setup: {error}"))?;
    Ok(prepared)
}

pub async fn execute_environment_prepare(args: &[String], timeout_seconds: f64) -> CommandResult {
    let Some(raw) = args.first() else {
        return CommandResult::error(
            "Execution environment definition is required".to_owned(),
            0.0,
            false,
        );
    };
    let definition: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(error) => {
            return CommandResult::error(
                format!("Invalid execution environment definition: {error}"),
                0.0,
                false,
            );
        }
    };
    let prepared = match tokio::time::timeout(
        std::time::Duration::from_secs_f64(timeout_seconds.max(0.001)),
        prepare_environment(&definition),
    )
    .await
    {
        Ok(Ok(request)) => request,
        Ok(Err(error)) => return CommandResult::error(error, 0.0, false),
        Err(_) => {
            return CommandResult::error(
                "Execution environment initialization timed out".to_owned(),
                0.0,
                true,
            );
        }
    };
    CommandResult::ok(serde_json::json!({
        "workspacePath": prepared.cwd().unwrap_or_default(),
    }))
}

fn prepare_blank_workspace(mut request: ExecutionRequest) -> Result<ExecutionRequest, String> {
    let environment_root = task_workspace_dir(&request.task_id).join("environment");
    std::fs::create_dir_all(&environment_root).map_err(|error| {
        format!(
            "Failed to create blank execution environment {}: {error}",
            environment_root.display()
        )
    })?;
    let workspace_path = environment_root.display().to_string();
    request.project_workspace_path = Some(workspace_path.clone());
    request.runtime_workspace_roots = vec![workspace_path.clone()];
    request
        .extra
        .insert("environment_root".to_owned(), Value::String(workspace_path));
    Ok(request)
}

fn build_prepare_request(environment_id: &str, definition: &Value) -> ExecutionRequest {
    let repositories = definition
        .get("repositories")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let setup_steps = definition
        .get("setupSteps")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let fingerprint = definition
        .get("fingerprint")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let mut request = ExecutionRequest {
        task_id: format!("environment-{environment_id}"),
        subtask_id: "prepare".to_owned(),
        ..ExecutionRequest::default()
    };
    // Preparation carries no task-scoped token, and repositories may span several
    // domains, so every clone resolves the credentials configured on the device.
    request.extra.insert(
        "git_auth_transport".to_owned(),
        Value::String(DEVICE_LOCAL.to_owned()),
    );
    request.extra.insert(
        "execution".to_owned(),
        serde_json::json!({
            "workspace": {
                "repositories": repositories,
            },
            "setup": {
                "steps": setup_steps,
                "fingerprint": fingerprint,
            },
        }),
    );
    request
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EnvGuard {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &std::path::Path) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    #[test]
    fn prepare_request_resolves_credentials_on_the_device() {
        let request = build_prepare_request(
            "project-1",
            &serde_json::json!({
                "repositories": [{
                    "url": "https://git.example.com/team/repository.git",
                    "path": "repository",
                    "primary": true
                }]
            }),
        );

        assert!(crate::agents::git_auth::uses_device_local_git_credentials(
            &request
        ));
    }

    #[tokio::test]
    async fn rejects_invalid_environment_definition_before_running_commands() {
        let result = execute_environment_prepare(&["not-json".to_owned()], 1.0).await;

        assert!(!result.success);
        assert_eq!(result.exit_code, None);
        assert!(result
            .error
            .as_deref()
            .is_some_and(|error| error.starts_with("Invalid execution environment definition:")));
    }

    #[tokio::test]
    async fn reports_repository_preparation_stage() {
        let result = execute_environment_prepare(
            &[serde_json::json!({
                "environmentId": "missing-primary",
                "repositories": [{
                    "name": "Repository",
                    "url": "https://example.com/repository.git",
                    "path": "repository",
                    "primary": false
                }]
            })
            .to_string()],
            1.0,
        )
        .await;

        assert!(!result.success);
        assert_eq!(
            result.error.as_deref(),
            Some(
                "Failed to prepare project repositories: \
Execution environment must have exactly one primary repository"
            )
        );
    }

    #[test]
    fn prepares_blank_workspace_and_runs_setup_without_repositories() {
        let _lock = crate::test_env::lock();
        let workspace = tempfile::tempdir().unwrap();
        let _workspace_root = EnvGuard::set("WORKSPACE_ROOT", workspace.path());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime.block_on(execute_environment_prepare(
            &[serde_json::json!({
                "environmentId": "blank-project",
                "repositories": [],
                "setupSteps": [{
                    "command": "echo ready > blank-environment.txt",
                    "workingDirectory": ""
                }],
                "fingerprint": "blank-v1"
            })
            .to_string()],
            5.0,
        ));

        let expected = workspace
            .path()
            .join("environment-blank-project")
            .join("environment");
        assert!(result.success, "{:?}", result.error);
        assert_eq!(
            result.stdout.get("workspacePath").and_then(Value::as_str),
            expected.to_str()
        );
        assert_eq!(
            std::fs::read_to_string(expected.join("blank-environment.txt"))
                .unwrap()
                .trim(),
            "ready"
        );
    }
}
