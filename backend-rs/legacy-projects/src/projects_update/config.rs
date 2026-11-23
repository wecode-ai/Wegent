// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app.schemas.project.ProjectConfig` request validation, including the
//! `validate_workspace_project` model-validator mutations, and
//! `_dump_config`'s `model_dump(mode="json", exclude_none=True)` document.
use serde_json::{Map, Value};

use crate::http_compat::FastApiError;

use super::super::{ProjectTaskSource, StoredProjectConfig};
use super::request::config_error;

// ============================================================================
// ProjectConfig validation (`app.schemas.project.ProjectConfig`)
// ============================================================================

/// The validated `execution` (`ProjectExecutionConfig`, `extra="forbid"`).
#[derive(Debug, Clone)]
struct ValidExecution {
    target_type: String,
    device_id: Option<String>,
}

/// The validated `team` (`ProjectTeamConfig`, `extra="forbid"`).
#[derive(Debug, Clone)]
struct ValidTeam {
    id: Option<i64>,
    name: Option<String>,
    namespace: String,
}

/// The validated `workspace` (`ProjectWorkspaceConfig`, `extra="forbid"`).
#[derive(Debug, Clone)]
struct ValidWorkspace {
    source: String,
    local_path: Option<String>,
    checkout_path: Option<String>,
    device_path: Option<String>,
    workspace_ref: Option<(String, String)>,
}

/// The validated `git` (`ProjectGitConfig`, `extra="forbid"`).
#[derive(Debug, Clone)]
struct ValidGit {
    url: String,
    repo: Option<String>,
    repo_id: Option<i64>,
    domain: Option<String>,
    branch: String,
}

/// The validated `modelSelection` (`ProjectModelSelection`,
/// `extra="forbid"`).
#[derive(Debug, Clone)]
struct ValidModelSelection {
    model_name: String,
    model_type: Option<String>,
    options: Map<String, Value>,
}

/// `str | None` with `extra="forbid"` semantics on the parent map.
fn field_str(
    object: &Map<String, Value>,
    loc: &[&str],
    key: &str,
) -> Result<Option<String>, FastApiError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(other) => Err(config_error(
            &loc_with(loc, key),
            "string_type",
            "Input should be a valid string",
            other,
        )),
    }
}

/// The nested location `[...loc, key]`.
fn loc_with<'a>(loc: &[&'a str], key: &'a str) -> Vec<&'a str> {
    let mut out = loc.to_vec();
    out.push(key);
    out
}

/// Reject an unknown key (`extra="forbid"`) of the map at `loc`.
fn forbid_extra(
    object: &Map<String, Value>,
    loc: &[&str],
    known: &[&str],
) -> Result<(), FastApiError> {
    if let Some((key, value)) = object
        .iter()
        .find(|(key, _)| !known.contains(&key.as_str()))
    {
        return Err(config_error(
            &loc_with(loc, key),
            "extra_forbidden",
            "Extra inputs are not permitted",
            value,
        ));
    }
    Ok(())
}

/// `mode: Optional[Literal["workspace"]]`.
fn valid_mode(object: &Map<String, Value>) -> Result<Option<String>, FastApiError> {
    match object.get("mode") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text == "workspace" => Ok(Some(text.clone())),
        Some(other) => Err(config_error(
            &["config", "mode"],
            "literal_error",
            "Input should be 'workspace'",
            other,
        )),
    }
}

/// `taskSource: Optional[Literal["api", "dingtalk"]]`.
fn valid_task_source(
    object: &Map<String, Value>,
) -> Result<Option<ProjectTaskSource>, FastApiError> {
    match object.get("taskSource") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text == "api" => Ok(Some(ProjectTaskSource::Api)),
        Some(Value::String(text)) if text == "dingtalk" => Ok(Some(ProjectTaskSource::Dingtalk)),
        Some(other) => Err(config_error(
            &["config", "taskSource"],
            "literal_error",
            "Input should be 'api' or 'dingtalk'",
            other,
        )),
    }
}

/// `execution: Optional[ProjectExecutionConfig]`.
fn valid_execution(object: &Map<String, Value>) -> Result<Option<ValidExecution>, FastApiError> {
    let Some(value) = object.get("execution") else {
        return Ok(None);
    };
    let Value::Object(execution) = value else {
        return Err(config_error(
            &["config", "execution"],
            "model_type",
            "Input should be a valid dictionary or instance of ProjectExecutionConfig",
            value,
        ));
    };
    forbid_extra(
        execution,
        &["config", "execution"],
        &["targetType", "deviceId"],
    )?;
    let Some(target_type) = field_str(execution, &["config", "execution"], "targetType")? else {
        return Err(config_error(
            &["config", "execution", "targetType"],
            "missing",
            "Field required",
            value,
        ));
    };
    if !matches!(target_type.as_str(), "local" | "cloud" | "remote") {
        return Err(config_error(
            &["config", "execution", "targetType"],
            "literal_error",
            "Input should be 'local', 'cloud' or 'remote'",
            &Value::String(target_type.clone()),
        ));
    }
    let device_id = field_str(execution, &["config", "execution"], "deviceId")?;
    // `validate_device`: concrete local/remote targets need a bound device.
    if matches!(target_type.as_str(), "local" | "remote") && device_id.is_none() {
        return Err(config_error(
            &["config", "execution"],
            "value_error",
            &format!("Value error, deviceId is required when targetType is {target_type}"),
            value,
        ));
    }
    Ok(Some(ValidExecution {
        target_type,
        device_id,
    }))
}

/// `team: Optional[ProjectTeamConfig]`.
fn valid_team(object: &Map<String, Value>) -> Result<Option<ValidTeam>, FastApiError> {
    let Some(value) = object.get("team") else {
        return Ok(None);
    };
    let Value::Object(team) = value else {
        return Err(config_error(
            &["config", "team"],
            "model_type",
            "Input should be a valid dictionary or instance of ProjectTeamConfig",
            value,
        ));
    };
    forbid_extra(team, &["config", "team"], &["id", "name", "namespace"])?;
    let id = match team.get("id") {
        None | Some(Value::Null) => None,
        Some(Value::Number(number)) => match number.as_i64() {
            Some(id) => Some(id),
            None => {
                return Err(config_error(
                    &["config", "team", "id"],
                    "int_parsing",
                    "Input should be a valid integer, unable to parse string as an integer",
                    &Value::Number(number.clone()),
                ));
            }
        },
        Some(other) => {
            return Err(config_error(
                &["config", "team", "id"],
                "int_parsing",
                "Input should be a valid integer, unable to parse string as an integer",
                other,
            ));
        }
    };
    let name = field_str(team, &["config", "team"], "name")?;
    let namespace =
        field_str(team, &["config", "team"], "namespace")?.unwrap_or_else(|| "default".to_string());
    if id.is_none() && name.is_none() {
        return Err(config_error(
            &["config", "team"],
            "value_error",
            "Value error, Either team.id or team.name is required",
            value,
        ));
    }
    Ok(Some(ValidTeam {
        id,
        name,
        namespace,
    }))
}

/// `workspaceRef: Optional[ProjectWorkspaceRef]` (`name` required,
/// min length 1).
fn valid_workspace_ref(
    workspace: &Map<String, Value>,
) -> Result<Option<(String, String)>, FastApiError> {
    let Some(value) = workspace.get("workspaceRef") else {
        return Ok(None);
    };
    let Value::Object(reference) = value else {
        return Err(config_error(
            &["config", "workspace", "workspaceRef"],
            "model_type",
            "Input should be a valid dictionary or instance of ProjectWorkspaceRef",
            value,
        ));
    };
    forbid_extra(
        reference,
        &["config", "workspace", "workspaceRef"],
        &["name", "namespace"],
    )?;
    let name = match reference.get("name") {
        None | Some(Value::Null) => {
            return Err(config_error(
                &["config", "workspace", "workspaceRef", "name"],
                "missing",
                "Field required",
                value,
            ));
        }
        Some(Value::String(text)) if text.is_empty() => {
            return Err(config_error(
                &["config", "workspace", "workspaceRef", "name"],
                "string_too_short",
                "String should have at least 1 character",
                &Value::String(text.clone()),
            ));
        }
        Some(Value::String(text)) => text.clone(),
        Some(other) => {
            return Err(config_error(
                &["config", "workspace", "workspaceRef", "name"],
                "string_type",
                "Input should be a valid string",
                other,
            ));
        }
    };
    let namespace = field_str(
        reference,
        &["config", "workspace", "workspaceRef"],
        "namespace",
    )?
    .unwrap_or_else(|| "default".to_string());
    Ok(Some((name, namespace)))
}

/// `workspace: Optional[ProjectWorkspaceConfig]`.
fn valid_workspace(object: &Map<String, Value>) -> Result<Option<ValidWorkspace>, FastApiError> {
    let Some(value) = object.get("workspace") else {
        return Ok(None);
    };
    let Value::Object(workspace) = value else {
        return Err(config_error(
            &["config", "workspace"],
            "model_type",
            "Input should be a valid dictionary or instance of ProjectWorkspaceConfig",
            value,
        ));
    };
    forbid_extra(
        workspace,
        &["config", "workspace"],
        &[
            "source",
            "localPath",
            "checkoutPath",
            "devicePath",
            "workspaceRef",
        ],
    )?;
    let Some(source) = field_str(workspace, &["config", "workspace"], "source")? else {
        return Err(config_error(
            &["config", "workspace", "source"],
            "missing",
            "Field required",
            value,
        ));
    };
    if !matches!(source.as_str(), "git" | "local_path" | "device_path") {
        return Err(config_error(
            &["config", "workspace", "source"],
            "literal_error",
            "Input should be 'git', 'local_path' or 'device_path'",
            &Value::String(source.clone()),
        ));
    }
    let local_path = field_str(workspace, &["config", "workspace"], "localPath")?;
    let checkout_path = field_str(workspace, &["config", "workspace"], "checkoutPath")?;
    let device_path = field_str(workspace, &["config", "workspace"], "devicePath")?;
    let workspace_ref = valid_workspace_ref(workspace)?;
    Ok(Some(ValidWorkspace {
        source,
        local_path,
        checkout_path,
        device_path,
        workspace_ref,
    }))
}

/// `git: Optional[ProjectGitConfig]` (`url` required, min length 1,
/// `branch` default `"main"`).
fn valid_git(object: &Map<String, Value>) -> Result<Option<ValidGit>, FastApiError> {
    let Some(value) = object.get("git") else {
        return Ok(None);
    };
    let Value::Object(git) = value else {
        return Err(config_error(
            &["config", "git"],
            "model_type",
            "Input should be a valid dictionary or instance of ProjectGitConfig",
            value,
        ));
    };
    forbid_extra(
        git,
        &["config", "git"],
        &["url", "repo", "repoId", "domain", "branch"],
    )?;
    let url = match git.get("url") {
        None | Some(Value::Null) => {
            return Err(config_error(
                &["config", "git", "url"],
                "missing",
                "Field required",
                value,
            ));
        }
        Some(Value::String(text)) if text.is_empty() => {
            return Err(config_error(
                &["config", "git", "url"],
                "string_too_short",
                "String should have at least 1 character",
                &Value::String(text.clone()),
            ));
        }
        Some(Value::String(text)) => text.clone(),
        Some(other) => {
            return Err(config_error(
                &["config", "git", "url"],
                "string_type",
                "Input should be a valid string",
                other,
            ));
        }
    };
    let repo = field_str(git, &["config", "git"], "repo")?;
    let repo_id = match git.get("repoId") {
        None | Some(Value::Null) => None,
        Some(Value::Number(number)) => match number.as_i64() {
            Some(id) => Some(id),
            None => {
                return Err(config_error(
                    &["config", "git", "repoId"],
                    "int_parsing",
                    "Input should be a valid integer, unable to parse string as an integer",
                    &Value::Number(number.clone()),
                ));
            }
        },
        Some(other) => {
            return Err(config_error(
                &["config", "git", "repoId"],
                "int_parsing",
                "Input should be a valid integer, unable to parse string as an integer",
                other,
            ));
        }
    };
    let domain = field_str(git, &["config", "git"], "domain")?;
    let branch =
        field_str(git, &["config", "git"], "branch")?.unwrap_or_else(|| "main".to_string());
    Ok(Some(ValidGit {
        url,
        repo,
        repo_id,
        domain,
        branch,
    }))
}

/// `modelSelection: Optional[ProjectModelSelection]` (`modelName` required,
/// min length 1; `modelType` an optional literal; `options` string values).
fn valid_model_selection(
    object: &Map<String, Value>,
) -> Result<Option<ValidModelSelection>, FastApiError> {
    let Some(value) = object.get("modelSelection") else {
        return Ok(None);
    };
    let Value::Object(selection) = value else {
        return Err(config_error(
            &["config", "modelSelection"],
            "model_type",
            "Input should be a valid dictionary or instance of ProjectModelSelection",
            value,
        ));
    };
    forbid_extra(
        selection,
        &["config", "modelSelection"],
        &["modelName", "modelType", "options"],
    )?;
    let model_name = match selection.get("modelName") {
        None | Some(Value::Null) => {
            return Err(config_error(
                &["config", "modelSelection", "modelName"],
                "missing",
                "Field required",
                value,
            ));
        }
        Some(Value::String(text)) if text.is_empty() => {
            return Err(config_error(
                &["config", "modelSelection", "modelName"],
                "string_too_short",
                "String should have at least 1 character",
                &Value::String(text.clone()),
            ));
        }
        Some(Value::String(text)) => text.clone(),
        Some(other) => {
            return Err(config_error(
                &["config", "modelSelection", "modelName"],
                "string_type",
                "Input should be a valid string",
                other,
            ));
        }
    };
    let model_type = match selection.get("modelType") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if matches!(text.as_str(), "public" | "user" | "group") => {
            Some(text.clone())
        }
        Some(other) => {
            return Err(config_error(
                &["config", "modelSelection", "modelType"],
                "literal_error",
                "Input should be 'public', 'user' or 'group'",
                other,
            ));
        }
    };
    let mut options = Map::new();
    if let Some(options_value) = selection.get("options") {
        let Value::Object(map) = options_value else {
            return Err(config_error(
                &["config", "modelSelection", "options"],
                "dict_type",
                "Input should be a valid dictionary",
                options_value,
            ));
        };
        for (key, entry) in map {
            let Value::String(text) = entry else {
                return Err(config_error(
                    &["config", "modelSelection", "options", key],
                    "string_type",
                    "Input should be a valid string",
                    entry,
                ));
            };
            options.insert(key.clone(), Value::String(text.clone()));
        }
    }
    Ok(Some(ValidModelSelection {
        model_name,
        model_type,
        options,
    }))
}

/// `get_project_path_from_url` (`shared/utils/git_util.py`): the path segment
/// of a Git URL, `/-`-truncated and `.git`-stripped.
fn git_project_path(url: &str) -> Option<String> {
    let mut url = url.to_string();
    if let Some(index) = url.find("/-/") {
        url.truncate(index);
    }
    if let Some(stripped) = url.strip_suffix(".git") {
        url = stripped.to_string();
    }
    if url.contains('@') && url.contains(':') {
        // SSH format (`git@domain.com:user/repo`): the part after the colon.
        return url.rsplit(':').next().map(str::to_string);
    }
    // Standard URL: the path without its leading slash.
    let path = match url.find("://") {
        Some(index) => url[index + 3..]
            .split_once('/')
            .map(|(_, path)| path.to_string()),
        None => Some(url.clone()),
    }?;
    let path = path.strip_prefix('/').unwrap_or(&path).to_string();
    Some(path)
}

/// `get_repo_name_from_url`: the last non-empty `/`-separated segment with
/// `/-` truncation and `.git` stripping.
fn git_repo_name(url: &str) -> String {
    let mut url = url.to_string();
    if let Some(index) = url.find("/-/") {
        url.truncate(index);
    }
    if let Some(stripped) = url.strip_suffix(".git") {
        url = stripped.to_string();
    }
    let parts: Vec<&str> = url.split('/').collect();
    if parts.last().is_some_and(|part| part.is_empty()) && parts.len() >= 2 {
        parts[parts.len() - 2].to_string()
    } else {
        parts.last().copied().unwrap_or_default().to_string()
    }
}

/// `get_safe_git_workspace_key`: the sanitized last path segment of the
/// repository reference.
fn safe_git_workspace_key(git: &ValidGit) -> String {
    let raw = git
        .repo
        .clone()
        .or_else(|| git_project_path(&git.url))
        .unwrap_or_else(|| git_repo_name(&git.url));
    let raw = raw.trim().trim_end_matches('/');
    let raw = raw.strip_suffix(".git").unwrap_or(raw);
    let last = raw.rsplit('/').next().unwrap_or_default();
    let sanitized: String = last
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized
        .trim_matches(|c| matches!(c, '.' | '_' | '-'))
        .to_string();
    if trimmed.is_empty() {
        "git_repo".to_string()
    } else {
        trimmed
    }
}

/// `ProjectConfig.model_validate` with its `model_validator` mutations.
pub(super) fn validate_project_config(value: &Value) -> Result<StoredProjectConfig, FastApiError> {
    let Value::Object(object) = value else {
        return Err(config_error(
            &["config"],
            "model_type",
            "Input should be a valid dictionary or instance of ProjectConfig",
            value,
        ));
    };
    forbid_extra(
        object,
        &["config"],
        &[
            "mode",
            "taskSource",
            "device_id",
            "execution",
            "team",
            "workspace",
            "git",
            "modelSelection",
        ],
    )?;
    let mode = valid_mode(object)?;
    let task_source = valid_task_source(object)?;
    let device_id = field_str(object, &["config"], "device_id")?;
    let mut execution = valid_execution(object)?;
    let team = valid_team(object)?;
    let mut workspace = valid_workspace(object)?;
    let git = valid_git(object)?;
    let model_selection = valid_model_selection(object)?;

    // `validate_workspace_project` only mutates a workspace-mode config.
    if mode.as_deref() == Some("workspace") {
        if execution.is_none()
            && let Some(device_id) = &device_id
        {
            execution = Some(ValidExecution {
                target_type: "local".to_string(),
                device_id: Some(device_id.clone()),
            });
        }
        if let Some(workspace) = workspace.as_mut() {
            match workspace.source.as_str() {
                "git" => {
                    let Some(git) = &git else {
                        return Err(config_error(
                            &["config"],
                            "value_error",
                            "Value error, git config is required when workspace.source is git",
                            value,
                        ));
                    };
                    if workspace.checkout_path.as_deref().unwrap_or("").is_empty() {
                        workspace.checkout_path = Some(safe_git_workspace_key(git));
                    }
                    if execution.as_ref().is_some_and(|execution| {
                        execution.target_type == "cloud"
                            && workspace
                                .checkout_path
                                .as_deref()
                                .is_some_and(|path| path.starts_with('/'))
                    }) {
                        return Err(config_error(
                            &["config"],
                            "value_error",
                            "Value error, cloud git checkoutPath must be relative",
                            value,
                        ));
                    }
                }
                "local_path" => {
                    if execution
                        .as_ref()
                        .is_none_or(|execution| execution.target_type != "local")
                    {
                        return Err(config_error(
                            &["config"],
                            "value_error",
                            "Value error, local_path source is only supported for local target",
                            value,
                        ));
                    }
                    if workspace.local_path.as_deref().is_none_or(str::is_empty) {
                        return Err(config_error(
                            &["config"],
                            "value_error",
                            "Value error, workspace.localPath is required for local_path source",
                            value,
                        ));
                    }
                    if git.is_some() {
                        return Err(config_error(
                            &["config"],
                            "value_error",
                            "Value error, git config must be empty for local_path source",
                            value,
                        ));
                    }
                }
                "device_path" => {
                    if !execution.as_ref().is_some_and(|execution| {
                        matches!(execution.target_type.as_str(), "cloud" | "remote")
                    }) {
                        return Err(config_error(
                            &["config"],
                            "value_error",
                            "Value error, device_path source is only supported for cloud or remote target",
                            value,
                        ));
                    }
                    if execution
                        .as_ref()
                        .and_then(|execution| execution.device_id.as_deref())
                        .is_none_or(str::is_empty)
                    {
                        return Err(config_error(
                            &["config"],
                            "value_error",
                            "Value error, execution.deviceId is required for device_path source",
                            value,
                        ));
                    }
                    if workspace.device_path.as_deref().is_none_or(str::is_empty) {
                        return Err(config_error(
                            &["config"],
                            "value_error",
                            "Value error, workspace.devicePath is required for device_path source",
                            value,
                        ));
                    }
                    if git.is_some() {
                        return Err(config_error(
                            &["config"],
                            "value_error",
                            "Value error, git config must be empty for device_path source",
                            value,
                        ));
                    }
                }
                _ => {}
            }
        }
    }

    Ok(StoredProjectConfig {
        mode,
        task_source,
        device_id,
        execution: execution.map(|execution| super::super::ProjectExecutionConfig {
            target_type: execution.target_type,
            device_id: execution.device_id,
        }),
        team: team.map(|team| super::super::ProjectTeamConfig {
            id: team.id,
            name: team.name,
            namespace: team.namespace,
        }),
        workspace: workspace.map(|workspace| super::super::ProjectWorkspaceConfig {
            source: workspace.source,
            local_path: workspace.local_path,
            checkout_path: workspace.checkout_path,
            device_path: workspace.device_path,
            workspace_ref: workspace
                .workspace_ref
                .map(|(name, namespace)| super::super::ProjectWorkspaceRef { name, namespace }),
        }),
        git: git.map(|git| super::super::ProjectGitConfig {
            url: git.url,
            repo: git.repo,
            repo_id: git.repo_id,
            domain: git.domain,
            branch: git.branch,
        }),
        model_selection: model_selection.map(|selection| super::super::ProjectModelSelection {
            model_name: selection.model_name,
            model_type: selection.model_type,
            options: Some(
                brz_json::RawJson::from_string(
                    serde_json::to_string(&selection.options).expect("options serialize as JSON"),
                )
                .expect("serialized options are valid JSON"),
            ),
        }),
    })
}

/// `_dump_config`: `config.model_dump(mode="json", exclude_none=True)` —
/// the validated config with every `None`-valued key dropped at each level.
pub(super) fn dump_config(config: &StoredProjectConfig) -> Value {
    fn strip_nulls(value: &Value) -> Value {
        match value {
            Value::Object(map) => Value::Object(
                map.iter()
                    .filter(|(_, value)| !value.is_null())
                    .map(|(key, value)| (key.clone(), strip_nulls(value)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }
    strip_nulls(&serde_json::to_value(config).expect("config serializes"))
}
