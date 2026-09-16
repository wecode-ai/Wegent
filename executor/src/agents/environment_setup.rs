// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{process::Command, time::timeout};

use crate::{
    logging::{log_executor_event, task_fields},
    protocol::ExecutionRequest,
};

const SETUP_COMMAND_TIMEOUT: Duration = Duration::from_secs(600);

pub async fn prepare_execution_environment(request: &ExecutionRequest) -> Result<(), String> {
    let setup = setup_definition(request)?;
    if setup.steps.is_empty() {
        return Ok(());
    }
    let cwd = request
        .cwd()
        .map(PathBuf::from)
        .ok_or_else(|| "Execution environment setup requires a workspace path".to_owned())?;
    let environment_root = request
        .extra
        .get("environment_root")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| cwd.clone());
    let marker = setup_marker_path(&environment_root, &setup.fingerprint);
    if marker.as_ref().is_some_and(|path| path.is_file()) {
        log_executor_event(
            "execution environment setup skipped",
            &[
                ("reason", "fingerprint_prepared".to_owned()),
                ("cwd", cwd.display().to_string()),
            ],
        );
        return Ok(());
    }

    for (index, step) in setup.steps.iter().enumerate() {
        let command_cwd = if step.working_directory.as_os_str().is_empty() {
            cwd.clone()
        } else {
            environment_root.join(&step.working_directory)
        };
        if !command_cwd.is_dir() {
            return Err(format!(
                "Execution environment setup working directory does not exist: {}",
                command_cwd.display()
            ));
        }
        let mut process = platform_shell(&step.command);
        crate::process::hide_windows_console(&mut process);
        process.current_dir(&command_cwd).kill_on_drop(true);
        let mut fields = task_fields(&request.task_id, &request.subtask_id);
        fields.push(("command_index", (index + 1).to_string()));
        fields.push(("cwd", command_cwd.display().to_string()));
        log_executor_event("execution environment setup started", &fields);

        let output = timeout(SETUP_COMMAND_TIMEOUT, process.output())
            .await
            .map_err(|_| {
                format!(
                    "Execution environment setup command {} timed out",
                    index + 1
                )
            })?
            .map_err(|error| {
                format!(
                    "Execution environment setup command {} could not start: {error}",
                    index + 1
                )
            })?;
        fields.push(("exit_code", output.status.code().unwrap_or(-1).to_string()));
        fields.push(("stdout_len", output.stdout.len().to_string()));
        fields.push(("stderr_len", output.stderr.len().to_string()));
        if !output.status.success() {
            log_executor_event("execution environment setup failed", &fields);
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            return Err(if stderr.is_empty() {
                format!(
                    "Execution environment setup command {} exited with code {}",
                    index + 1,
                    output.status.code().unwrap_or(-1)
                )
            } else {
                format!(
                    "Execution environment setup command {} failed: {stderr}",
                    index + 1
                )
            });
        }
        log_executor_event("execution environment setup finished", &fields);
    }
    if let Some(marker) = marker {
        let parent = marker.parent().ok_or_else(|| {
            "Execution environment setup marker has no parent directory".to_owned()
        })?;
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create execution environment setup marker directory {}: {error}",
                parent.display()
            )
        })?;
        fs::write(&marker, setup.fingerprint.as_bytes()).map_err(|error| {
            format!(
                "Failed to write execution environment setup marker {}: {error}",
                marker.display()
            )
        })?;
    }
    Ok(())
}

struct SetupDefinition {
    steps: Vec<SetupStep>,
    fingerprint: String,
}

struct SetupStep {
    command: String,
    working_directory: PathBuf,
}

fn setup_definition(request: &ExecutionRequest) -> Result<SetupDefinition, String> {
    let Some(setup) = request
        .extra
        .get("execution")
        .and_then(|execution| execution.get("setup"))
    else {
        return Ok(SetupDefinition {
            steps: Vec::new(),
            fingerprint: String::new(),
        });
    };
    let Some(steps) = setup.get("steps") else {
        return Ok(SetupDefinition {
            steps: Vec::new(),
            fingerprint: String::new(),
        });
    };
    let values = steps
        .as_array()
        .ok_or_else(|| "Execution environment setup steps must be an array".to_owned())?;
    let steps = values
        .iter()
        .map(|value| {
            let command = value
                .get("command")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|command| !command.is_empty())
                .ok_or_else(|| "Execution environment setup step command is required".to_owned())?;
            let working_directory = value
                .get("workingDirectory")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            let working_directory = PathBuf::from(working_directory);
            if working_directory.is_absolute()
                || working_directory
                    .components()
                    .any(|component| !matches!(component, std::path::Component::Normal(_)))
            {
                return Err(
                    "Execution environment setup working directory must be relative".to_owned(),
                );
            }
            Ok(SetupStep {
                command: command.to_owned(),
                working_directory,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SetupDefinition {
        steps,
        fingerprint: setup
            .get("fingerprint")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_owned(),
    })
}

fn setup_marker_path(cwd: &Path, fingerprint: &str) -> Option<PathBuf> {
    if fingerprint.is_empty() {
        return None;
    }
    let digest = format!("{:x}", Sha256::digest(fingerprint.as_bytes()));
    Some(
        git_metadata_dir(cwd)
            .unwrap_or_else(|| cwd.join(".wegent"))
            .join("environment-setup")
            .join(format!("environment-setup-{digest}.ready")),
    )
}

fn git_metadata_dir(cwd: &Path) -> Option<PathBuf> {
    let dot_git = cwd.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let content = fs::read_to_string(dot_git).ok()?;
    let value = content.strip_prefix("gitdir:")?.trim();
    let path = PathBuf::from(value);
    Some(if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    })
}

#[cfg(target_os = "windows")]
fn platform_shell(command: &str) -> Command {
    let mut process = Command::new("cmd.exe");
    process.arg("/D").arg("/S").arg("/C").arg(command);
    process
}

#[cfg(not(target_os = "windows"))]
fn platform_shell(command: &str) -> Command {
    let mut process = Command::new("bash");
    process.arg("-lc").arg(command);
    process
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_setup_steps_from_execution_snapshot() {
        let mut request = ExecutionRequest::default();
        request.extra.insert(
            "execution".to_owned(),
            json!({
                "setup": {
                    "steps": [
                        {"command": " npm ci ", "workingDirectory": ""},
                        {"command": "pnpm test", "workingDirectory": "frontend"}
                    ],
                    "fingerprint": "environment-v1",
                }
            }),
        );

        let setup = setup_definition(&request).unwrap();
        assert_eq!(setup.steps.len(), 2);
        assert_eq!(setup.steps[0].command, "npm ci");
        assert_eq!(setup.steps[0].working_directory, PathBuf::new());
        assert_eq!(setup.steps[1].command, "pnpm test");
        assert_eq!(setup.steps[1].working_directory, PathBuf::from("frontend"));
        assert_eq!(setup.fingerprint, "environment-v1");
    }

    #[test]
    fn rejects_setup_steps_without_commands() {
        let mut request = ExecutionRequest::default();
        request.extra.insert(
            "execution".to_owned(),
            json!({"setup": {"steps": [{"command": "npm ci"}, 42]}}),
        );

        assert!(setup_definition(&request).is_err());
    }

    #[tokio::test]
    async fn skips_setup_after_the_same_fingerprint_succeeds_in_a_workspace() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join(".git")).unwrap();
        let output = directory.path().join("setup-count");
        let mut request = ExecutionRequest {
            project_workspace_path: Some(directory.path().display().to_string()),
            ..ExecutionRequest::default()
        };
        request.extra.insert(
            "execution".to_owned(),
            json!({
                "setup": {
                    "steps": [{"command": format!("printf x >> '{}'", output.display())}],
                    "fingerprint": "environment-v1",
                }
            }),
        );

        prepare_execution_environment(&request).await.unwrap();
        prepare_execution_environment(&request).await.unwrap();

        assert_eq!(fs::read_to_string(output).unwrap(), "x");
    }
}
