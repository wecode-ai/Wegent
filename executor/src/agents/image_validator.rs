// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{future::Future, pin::Pin, process::Stdio, time::Duration};

use serde::Serialize;
use serde_json::Value;
use tokio::{process::Command, time};

use crate::{
    protocol::ExecutionRequest,
    runner::{AgentEngine, ExecutionOutcome},
};

#[derive(Debug, Clone)]
pub struct ImageValidatorEngine;

impl AgentEngine for ImageValidatorEngine {
    type RunFuture = Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>;

    fn run(&self, request: ExecutionRequest) -> Self::RunFuture {
        Box::pin(async move {
            match validate_image(request).await {
                Ok(result) => ExecutionOutcome::Completed {
                    content: serde_json::to_string(&result).unwrap_or_default(),
                },
                Err(message) => ExecutionOutcome::Failed { message },
            }
        })
    }
}

#[derive(Debug, Clone)]
struct ValidationCheck {
    name: &'static str,
    command: &'static str,
    min_version: Option<&'static str>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ValidationResult {
    pub valid: bool,
    pub checks: Vec<CheckResult>,
    pub errors: Vec<String>,
    pub shell_name: String,
    pub shell_type: String,
    pub image: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CheckResult {
    pub name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

async fn validate_image(request: ExecutionRequest) -> Result<ValidationResult, String> {
    let shell_type = validation_string(&request.validation_params, "shell_type");
    if shell_type.is_empty() {
        return Err("shell_type is required for validation".to_owned());
    }
    let checks =
        checks_for_shell(&shell_type).ok_or_else(|| format!("Unknown shell type: {shell_type}"))?;
    let mut results = Vec::with_capacity(checks.len());
    for check in checks {
        results.push(run_check(check).await);
    }
    let valid = results.iter().all(|result| result.status == "pass");
    Ok(ValidationResult {
        valid,
        checks: results,
        errors: Vec::new(),
        shell_name: validation_string(&request.validation_params, "shell_name"),
        shell_type,
        image: validation_string(&request.validation_params, "image"),
    })
}

async fn run_check(check: ValidationCheck) -> CheckResult {
    let mut command = Command::new("sh");
    command
        .args(["-c", check.command])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return failed_check(check.name, error.to_string()),
    };
    let output = match time::timeout(Duration::from_secs(30), child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return failed_check(check.name, error.to_string()),
        Err(_) => return failed_check(check.name, "Check timed out".to_owned()),
    };
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !output.status.success() || stdout.to_ascii_lowercase().contains("not found") {
        return failed_check(check.name, "Command failed or not found".to_owned());
    }
    let Some(version) = extract_semver(&stdout) else {
        return CheckResult {
            name: check.name.to_owned(),
            status: "pass".to_owned(),
            version: None,
            message: Some("Detected but version not parsed".to_owned()),
        };
    };
    if let Some(min_version) = check.min_version {
        if semver_lt(&version, min_version) {
            return CheckResult {
                name: check.name.to_owned(),
                status: "fail".to_owned(),
                version: Some(version.clone()),
                message: Some(format!("Version {version} < required {min_version}")),
            };
        }
    }
    CheckResult {
        name: check.name.to_owned(),
        status: "pass".to_owned(),
        version: Some(version),
        message: None,
    }
}

fn checks_for_shell(shell_type: &str) -> Option<Vec<ValidationCheck>> {
    match shell_type {
        "ClaudeCode" => Some(vec![
            ValidationCheck {
                name: "node",
                command: "node --version",
                min_version: Some("20.0.0"),
            },
            ValidationCheck {
                name: "claude-code",
                command: "claude --version 2>/dev/null || echo 'not found'",
                min_version: None,
            },
            ValidationCheck {
                name: "python",
                command: "python3 --version",
                min_version: Some("3.12.0"),
            },
        ]),
        "Agno" => Some(vec![
            ValidationCheck {
                name: "python",
                command: "python3 --version",
                min_version: Some("3.12.0"),
            },
            ValidationCheck {
                name: "sqlite",
                command: "sqlite3 --version",
                min_version: Some("3.50.0"),
            },
        ]),
        _ => None,
    }
}

fn failed_check(name: &str, message: String) -> CheckResult {
    CheckResult {
        name: name.to_owned(),
        status: "fail".to_owned(),
        version: None,
        message: Some(message),
    }
}

fn validation_string(params: &Value, key: &str) -> String {
    params
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn extract_semver(output: &str) -> Option<String> {
    for token in
        output.split(|character: char| !character.is_ascii_alphanumeric() && character != '.')
    {
        let version = token.trim_start_matches('v');
        if is_semver(version) {
            return Some(version.to_owned());
        }
    }
    None
}

fn is_semver(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty() && part.chars().all(|character| character.is_ascii_digit())
        })
}

fn semver_lt(left: &str, right: &str) -> bool {
    parse_semver(left) < parse_semver(right)
}

fn parse_semver(value: &str) -> (u64, u64, u64) {
    let mut parts = value.split('.').map(|part| part.parse().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}
