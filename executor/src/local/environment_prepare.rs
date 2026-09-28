// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

use crate::{
    agents::git_auth::DEVICE_LOCAL, local::command::CommandResult, protocol::ExecutionRequest,
    workspace_paths::task_workspace_dir,
};

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
    let environment_id = definition
        .get("environmentId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("default");
    let request = build_prepare_request(environment_id, &definition);
    let repository_free = definition
        .get("repositories")
        .and_then(Value::as_array)
        .map_or(true, Vec::is_empty);
    let prepared = match tokio::time::timeout(
        std::time::Duration::from_secs_f64(timeout_seconds.max(0.001)),
        async {
            let request = if repository_free {
                prepare_blank_workspace(request)?
            } else {
                request
            };
            let prepared = crate::agents::git_workspace::prepare_git_workspace(request)
                .await
                .map_err(|error| format!("Failed to prepare execution repositories: {error}"))?;
            crate::agents::environment_setup::prepare_execution_environment(&prepared)
                .await
                .map_err(|error| format!("Failed to run execution environment setup: {error}"))?;
            Ok::<_, String>(prepared)
        },
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
                "Failed to prepare execution repositories: \
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
