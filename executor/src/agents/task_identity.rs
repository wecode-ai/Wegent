// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::{protocol::ExecutionRequest, runtime_work::runtime_task_title};

pub(super) fn task_identity_env(request: &ExecutionRequest) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();

    if let Ok(executable) = std::env::current_exe() {
        env.insert(
            "WEGENT_EXECUTOR_BINARY".to_owned(),
            executable.to_string_lossy().into_owned(),
        );
    }

    if !request.task_id.trim().is_empty() {
        env.insert("WEGENT_TASK_ID".to_owned(), request.task_id.clone());
        let workspace_root = std::env::var("WORKSPACE_ROOT")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/workspace"));
        let task_workspace = request
            .cwd()
            .map(PathBuf::from)
            .map(|path| {
                if path.is_absolute() {
                    path
                } else {
                    workspace_root.join(path)
                }
            })
            .unwrap_or_else(|| workspace_root.join(request.task_id.trim()));
        env.insert(
            "WEGENT_TASK_WORKSPACE".to_owned(),
            task_workspace.to_string_lossy().into_owned(),
        );
    }
    if let Some(title) = runtime_task_title(request) {
        env.insert("WEWORK_PARENT_TITLE".to_owned(), title);
    }
    if let Some(auth_token) = non_empty(request.auth_token.as_deref()) {
        env.insert("AUTH_TOKEN".to_owned(), auth_token.to_owned());
    }
    if let Some(runtime_auth_token) = non_empty(request.runtime_auth_token.as_deref()) {
        env.insert(
            "WEGENT_RUNTIME_AUTH_TOKEN".to_owned(),
            runtime_auth_token.to_owned(),
        );
    }
    if let Some(token) = non_empty(request.skill_identity_token.as_deref()) {
        env.insert("WEGENT_SKILL_IDENTITY_TOKEN".to_owned(), token.to_owned());
    }
    if let Some(user_name) = non_empty(request.user_name.as_deref()) {
        env.insert("WEGENT_SKILL_USER_NAME".to_owned(), user_name.to_owned());
    }

    env
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_materialized_workspace_path_for_task_workspace() {
        let mut request = ExecutionRequest {
            task_id: "task-1".to_owned(),
            project_workspace_path: Some("/runtime/workspaces/task-1".to_owned()),
            ..ExecutionRequest::default()
        };
        request.extra.insert(
            "runtimeTaskTitle".to_owned(),
            serde_json::json!("Identify local development instances"),
        );

        let env = task_identity_env(&request);

        assert_eq!(env.get("WEGENT_TASK_ID"), Some(&"task-1".to_owned()));
        assert_eq!(
            env.get("WEGENT_TASK_WORKSPACE"),
            Some(&"/runtime/workspaces/task-1".to_owned())
        );
        assert_eq!(
            env.get("WEWORK_PARENT_TITLE"),
            Some(&"Identify local development instances".to_owned())
        );
    }
}
