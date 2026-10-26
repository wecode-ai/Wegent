// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared `WorkspaceResponse` rendering: the pydantic naive-datetime
//! serialization and the `ExecutionEnvironmentConfig` (`app.schemas.workspace`)
//! model_dump, used by the workspaces list and point reads.

use chrono::NaiveDateTime;

use crate::http_compat::FastApiError;

/// `ExecutionEnvironmentRepository` maxima from the source schema.
const NAME_MAX: usize = 100;
const URL_MAX: usize = 2000;
const REF_MAX: usize = 255;
const PATH_MAX: usize = 500;
const COMMAND_MAX: usize = 2000;
const WORKING_DIRECTORY_MAX: usize = 500;

/// `ExecutionEnvironmentDefinition` list maxima.
const REPOSITORIES_MAX: usize = 20;
const SETUP_STEPS_MAX: usize = 50;

/// pydantic naive-datetime serialization: `YYYY-MM-DDTHH:MM:SS` plus
/// fractional seconds when nonzero.
pub(crate) fn datetime_value(value: NaiveDateTime) -> String {
    let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        base
    } else {
        format!("{base}.{:06}", value.and_utc().timestamp_subsec_micros())
    }
}

/// `ExecutionEnvironmentConfig` (`app.schemas.workspace`): the shared
/// execution-environment definition plus the per-device preparation state,
/// rendered with the source `model_dump` field order.
#[derive(Debug, serde::Serialize)]
pub(crate) struct ExecutionEnvironment {
    pub(crate) workspace_policy: &'static str,
    pub(crate) repositories: Vec<ExecutionRepository>,
    pub(crate) setup_steps: Vec<ExecutionSetupStep>,
    pub(crate) fingerprint: String,
    pub(crate) devices: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct ExecutionRepository {
    pub(crate) name: String,
    pub(crate) url: String,
    pub(crate) r#ref: String,
    pub(crate) path: String,
    pub(crate) primary: bool,
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct ExecutionSetupStep {
    pub(crate) command: String,
    pub(crate) working_directory: String,
}

/// A pydantic `ValidationError` surface: `workspace_from_kind` validates the
/// stored `spec.executionEnvironment` through
/// `ExecutionEnvironmentConfig.model_validate`, and the application exception
/// handler renders the failure as `500 {"error_code": 500, "detail":
/// "Internal server error"}`.
fn invalid_environment(reason: &str) -> FastApiError {
    tracing::error!(reason, "invalid execution environment in kinds json");
    FastApiError::unhandled()
}

/// A required trimmed string field (`min_length=1`): absent, null, non-string,
/// blank, or oversized values fail validation.
fn required_text(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    max: usize,
) -> Result<String, FastApiError> {
    let value = object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| invalid_environment(key))?;
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max {
        return Err(invalid_environment(key));
    }
    Ok(trimmed.to_string())
}

/// An optional trimmed string field (default `""`): null or non-string values
/// still fail validation, and the result may stay empty.
fn optional_text(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    max: usize,
) -> Result<String, FastApiError> {
    match object.get(key) {
        None => Ok(String::new()),
        Some(value) => {
            let trimmed = value
                .as_str()
                .ok_or_else(|| invalid_environment(key))?
                .trim();
            if trimmed.len() > max {
                return Err(invalid_environment(key));
            }
            Ok(trimmed.to_string())
        }
    }
}

/// An optional plain string field with no validator (default `""`).
fn plain_text(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<String, FastApiError> {
    match object.get(key) {
        None => Ok(String::new()),
        Some(value) => value
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| invalid_environment(key)),
    }
}

/// An optional boolean field (default `false`).
fn optional_bool(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<bool, FastApiError> {
    match object.get(key) {
        None => Ok(false),
        Some(serde_json::Value::Bool(value)) => Ok(*value),
        Some(_) => Err(invalid_environment(key)),
    }
}

/// `require_relative_path` / `require_relative_working_directory`: backslashes
/// become forward slashes, and a leading separator or any empty, `.`, or `..`
/// segment is rejected; the result is rejoined with `/`.
fn normalized_relative_path(value: &str) -> Result<String, FastApiError> {
    if value.starts_with(['/', '\\']) {
        return Err(invalid_environment("path"));
    }
    let normalized = value.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').collect();
    if parts.iter().any(|part| matches!(*part, "" | "." | "..")) {
        return Err(invalid_environment("path"));
    }
    Ok(parts.join("/"))
}

/// `ExecutionEnvironmentDeviceState.prepared_at`: `null` or a datetime the
/// pydantic lax parser accepts, re-rendered with pydantic's serializer
/// (fractional microseconds only when nonzero; a UTC offset renders as `Z`,
/// any other offset keeps `±HH:MM`).
fn prepared_at_value(
    object: &serde_json::Map<String, serde_json::Value>,
) -> Result<serde_json::Value, FastApiError> {
    let text = match object.get("prepared_at") {
        None | Some(serde_json::Value::Null) => return Ok(serde_json::Value::Null),
        Some(serde_json::Value::String(text)) => text.as_str(),
        Some(_) => return Err(invalid_environment("prepared_at")),
    };
    if let Ok(offset) = chrono::DateTime::parse_from_rfc3339(text) {
        let base = offset.format("%Y-%m-%dT%H:%M:%S").to_string();
        let micros = offset.timestamp_subsec_micros();
        let fraction = if micros == 0 {
            String::new()
        } else {
            format!(".{micros:06}")
        };
        // Pydantic serializes a zero offset as `Z`; non-UTC offsets keep the
        // `±HH:MM` rendering.
        let suffix = if offset.offset().local_minus_utc() == 0 {
            "Z".to_string()
        } else {
            offset.format("%:z").to_string()
        };
        return Ok(serde_json::Value::String(format!(
            "{base}{fraction}{suffix}"
        )));
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(text, format) {
            return Ok(serde_json::Value::String(datetime_value(naive)));
        }
    }
    Err(invalid_environment("prepared_at"))
}

/// `ExecutionEnvironmentDefinition.repositories`: the field validators plus
/// the `validate_repositories` model validator.
fn validated_repositories(
    source: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<Vec<ExecutionRepository>, FastApiError> {
    let Some(raw) = source.and_then(|object| object.get("repositories")) else {
        return Ok(Vec::new());
    };
    let list = raw
        .as_array()
        .ok_or_else(|| invalid_environment("repositories"))?;
    if list.len() > REPOSITORIES_MAX {
        return Err(invalid_environment("repositories"));
    }
    let mut repositories = Vec::new();
    for item in list {
        let object = item
            .as_object()
            .ok_or_else(|| invalid_environment("repositories"))?;
        let path = required_text(object, "path", PATH_MAX)?;
        repositories.push(ExecutionRepository {
            name: required_text(object, "name", NAME_MAX)?,
            url: required_text(object, "url", URL_MAX)?,
            r#ref: optional_text(object, "ref", REF_MAX)?,
            path: normalized_relative_path(&path)?,
            primary: optional_bool(object, "primary")?,
        });
    }
    if !repositories.is_empty() && repositories.iter().filter(|item| item.primary).count() != 1 {
        return Err(invalid_environment("primary repository"));
    }
    let names: Vec<&str> = repositories.iter().map(|item| item.name.as_str()).collect();
    if names.len() != names.iter().collect::<std::collections::HashSet<_>>().len() {
        return Err(invalid_environment("repository names must be unique"));
    }
    let paths: Vec<&str> = repositories.iter().map(|item| item.path.as_str()).collect();
    if paths.len() != paths.iter().collect::<std::collections::HashSet<_>>().len() {
        return Err(invalid_environment("repository paths must be unique"));
    }
    for (index, left) in paths.iter().enumerate() {
        for right in paths.iter().skip(index + 1) {
            if left != right
                && (left.starts_with(&format!("{right}/"))
                    || right.starts_with(&format!("{left}/")))
            {
                return Err(invalid_environment("repository paths must not overlap"));
            }
        }
    }
    Ok(repositories)
}

/// `ExecutionEnvironmentDefinition.setup_steps`: the field validators; the
/// inside-a-repository check runs once both lists are validated.
fn validated_setup_steps(
    source: Option<&serde_json::Map<String, serde_json::Value>>,
    paths: &[&str],
) -> Result<Vec<ExecutionSetupStep>, FastApiError> {
    let Some(raw) = source.and_then(|object| object.get("setup_steps")) else {
        return Ok(Vec::new());
    };
    let list = raw
        .as_array()
        .ok_or_else(|| invalid_environment("setup_steps"))?;
    if list.len() > SETUP_STEPS_MAX {
        return Err(invalid_environment("setup_steps"));
    }
    let mut steps = Vec::new();
    for item in list {
        let object = item
            .as_object()
            .ok_or_else(|| invalid_environment("setup_steps"))?;
        let working_directory = optional_text(object, "working_directory", WORKING_DIRECTORY_MAX)?;
        let working_directory = if working_directory.is_empty() {
            working_directory
        } else {
            normalized_relative_path(&working_directory)?
        };
        steps.push(ExecutionSetupStep {
            command: required_text(object, "command", COMMAND_MAX)?,
            working_directory,
        });
    }
    if !paths.is_empty() {
        for step in &steps {
            if !step.working_directory.is_empty()
                && !paths.iter().any(|path| {
                    step.working_directory == *path
                        || step.working_directory.starts_with(&format!("{path}/"))
                })
            {
                return Err(invalid_environment(
                    "setup working directory must be inside a configured repository",
                ));
            }
        }
    }
    Ok(steps)
}

/// `ExecutionEnvironmentConfig.devices`: every value re-validated as an
/// `ExecutionEnvironmentDeviceState` and rendered with its four fields.
fn validated_devices(
    source: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<serde_json::Map<String, serde_json::Value>, FastApiError> {
    let mut devices = serde_json::Map::new();
    let Some(raw) = source.and_then(|object| object.get("devices")) else {
        return Ok(devices);
    };
    let object = raw
        .as_object()
        .ok_or_else(|| invalid_environment("devices"))?;
    for (key, value) in object {
        let device = value
            .as_object()
            .ok_or_else(|| invalid_environment("devices"))?;
        let status = match device.get("status") {
            None => "preparing",
            Some(serde_json::Value::String(status))
                if matches!(status.as_str(), "preparing" | "ready" | "error") =>
            {
                status.as_str()
            }
            Some(_) => return Err(invalid_environment("device status")),
        };
        devices.insert(
            key.clone(),
            serde_json::json!({
                "status": status,
                "workspace_path": plain_text(device, "workspace_path")?,
                "prepared_at": prepared_at_value(device)?,
                "error": plain_text(device, "error")?,
            }),
        );
    }
    Ok(devices)
}

/// `ExecutionEnvironmentDefinition.workspace_policy`: absent keeps the
/// `git_worktree` default; any other value fails the `Literal` validation.
fn validated_workspace_policy(
    source: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<&'static str, FastApiError> {
    match source.and_then(|object| object.get("workspace_policy")) {
        None => Ok("git_worktree"),
        Some(serde_json::Value::String(policy)) => match policy.as_str() {
            "git_worktree" | "project" => Ok(match policy.as_str() {
                "project" => "project",
                _ => "git_worktree",
            }),
            _ => Err(invalid_environment("workspace_policy")),
        },
        Some(_) => Err(invalid_environment("workspace_policy")),
    }
}

/// `ExecutionEnvironmentConfig.model_validate(spec.get("executionEnvironment")
/// or {}).model_dump()`.
pub(crate) fn execution_environment(
    json: &serde_json::Value,
) -> Result<ExecutionEnvironment, FastApiError> {
    let source = json
        .get("spec")
        .and_then(|spec| spec.get("executionEnvironment"))
        .and_then(serde_json::Value::as_object);
    let repositories = validated_repositories(source)?;
    let paths: Vec<&str> = repositories.iter().map(|item| item.path.as_str()).collect();
    Ok(ExecutionEnvironment {
        workspace_policy: validated_workspace_policy(source)?,
        setup_steps: validated_setup_steps(source, &paths)?,
        fingerprint: source
            .map(|object| plain_text(object, "fingerprint"))
            .transpose()?
            .unwrap_or_default(),
        devices: validated_devices(source)?,
        repositories,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_spec_renders_the_default_environment() {
        let json = serde_json::json!({"spec": {"executionEnvironment": {}}});
        let rendered =
            crate::json_contract_tests::serialized(execution_environment(&json).unwrap()).unwrap();
        let keys: Vec<&str> = rendered
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "workspace_policy",
                "repositories",
                "setup_steps",
                "fingerprint",
                "devices"
            ]
        );
        assert_eq!(rendered["workspace_policy"], "git_worktree");
    }

    #[test]
    fn repository_fields_are_trimmed_and_normalized() {
        let json = serde_json::json!({"spec": {"executionEnvironment": {
            "workspace_policy": "project",
            "repositories": [{"name": " main ", "url": " https://x ", "ref": " dev ",
                "path": "src\\main", "primary": true}],
            "setup_steps": [{"command": " make ", "working_directory": "src/main/sub"}],
            "fingerprint": "abc"
        }}});
        let environment = execution_environment(&json).unwrap();
        assert_eq!(environment.workspace_policy, "project");
        assert_eq!(environment.repositories[0].name, "main");
        assert_eq!(environment.repositories[0].url, "https://x");
        assert_eq!(environment.repositories[0].r#ref, "dev");
        assert_eq!(environment.repositories[0].path, "src/main");
        assert!(environment.repositories[0].primary);
        assert_eq!(environment.setup_steps[0].command, "make");
        assert_eq!(environment.setup_steps[0].working_directory, "src/main/sub");
        assert_eq!(environment.fingerprint, "abc");
    }

    #[test]
    fn multiple_primary_repositories_are_rejected() {
        let json = serde_json::json!({"spec": {"executionEnvironment": {
            "repositories": [
                {"name": "a", "url": "u", "path": "a", "primary": true},
                {"name": "b", "url": "u", "path": "b", "primary": true}
            ]
        }}});
        let error = execution_environment(&json).unwrap_err();
        assert_eq!(error.status(), 500);
    }

    #[test]
    fn absolute_or_dotted_paths_are_rejected() {
        for path in ["/abs", "a/../b", "a//b", "a/."] {
            let json = serde_json::json!({"spec": {"executionEnvironment": {
                "repositories": [{"name": "a", "url": "u", "path": path, "primary": true}]
            }}});
            assert!(execution_environment(&json).is_err(), "path {path}");
        }
    }

    #[test]
    fn unknown_workspace_policy_is_rejected() {
        let json = serde_json::json!({"spec": {"executionEnvironment": {
            "workspace_policy": "bogus"
        }}});
        assert_eq!(execution_environment(&json).unwrap_err().status(), 500);
    }

    #[test]
    fn device_states_are_revalidated_and_rendered() {
        let json = serde_json::json!({"spec": {"executionEnvironment": {
            "devices": {"7": {"status": "ready", "workspace_path": "/w",
                "prepared_at": "2026-10-14 03:31:30", "error": "", "extra": 1}}
        }}});
        let rendered =
            crate::json_contract_tests::serialized(execution_environment(&json).unwrap()).unwrap();
        let device = &rendered["devices"]["7"];
        let keys: Vec<&str> = device
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["status", "workspace_path", "prepared_at", "error"]);
        assert_eq!(device["status"], "ready");
        assert_eq!(device["prepared_at"], "2026-10-14T03:31:30");

        let invalid = serde_json::json!({"spec": {"executionEnvironment": {
            "devices": {"7": {"status": "gone"}}
        }}});
        assert_eq!(execution_environment(&invalid).unwrap_err().status(), 500);
    }

    #[test]
    fn aware_prepared_at_renders_like_pydantic() {
        for (input, expected) in [
            (
                "2026-10-08T07:01:47.709868+00:00",
                "2026-10-08T07:01:47.709868Z",
            ),
            ("2026-10-08T07:01:47Z", "2026-10-08T07:01:47Z"),
            (
                "2026-10-08T07:01:47.709868+08:00",
                "2026-10-08T07:01:47.709868+08:00",
            ),
        ] {
            let json = serde_json::json!({"spec": {"executionEnvironment": {
                "devices": {"7": {"prepared_at": input}}
            }}});
            let rendered =
                crate::json_contract_tests::serialized(execution_environment(&json).unwrap())
                    .unwrap();
            assert_eq!(
                rendered["devices"]["7"]["prepared_at"], expected,
                "input {input}"
            );
        }
    }

    #[test]
    fn naive_datetime_renders_second_precision() {
        let value =
            NaiveDateTime::parse_from_str("2026-09-14 06:39:15", "%Y-%m-%d %H:%M:%S").unwrap();
        assert_eq!(datetime_value(value), "2026-09-14T06:39:15");
    }
}
