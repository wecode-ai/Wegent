// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

use crate::{
    agents::git_auth::DEVICE_LOCAL, local::command::CommandResult, protocol::ExecutionRequest,
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
    let prepared = match tokio::time::timeout(
        std::time::Duration::from_secs_f64(timeout_seconds.max(0.001)),
        async {
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
}
