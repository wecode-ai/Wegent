// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `_merge_project_workspace`
//! (`app/services/execution/request_builder.py:3155-3235`).
//!
//! `TaskRequestBuilder._build_workspace_data` resolves the task's project once
//! the task row carries `project_id` (API-created tasks are attached to their
//! source group, so the id is always present) and merges the project's
//! workspace configuration into the execution workspace.
//!
//! The source wraps the whole workspace build in `try/except Exception` and
//! logs a warning, so a failed lookup degrades to the default workspace instead
//! of failing the request.

use crate::projects::PROJECT_COLUMNS;
use crate::task_store::StatementArg;
use brz_json::OpaqueJson;
use brz_mysql::{Json, Mysql, MysqlRow};
use serde_json::{Map, Value};

/// `_build_workspace_data`'s Workspace read (`task_store.get_workspace_by_ref`)
/// and its `spec.repository` projection. A missing row or an unparsable CRD
/// keeps the default workspace, like the source's `try/except`.
pub(super) async fn workspace_repository(
    task_store: &dyn crate::task_store::TaskStore,
    task_json: &Value,
    user_id: i64,
) -> Option<(Value, String)> {
    let reference = task_json.get("spec")?.get("workspaceRef")?;
    let name = reference.get("name")?.as_str()?;
    let namespace = reference
        .get("namespace")
        .and_then(Value::as_str)
        .unwrap_or("default");
    let row = match task_store
        .get_workspace_by_ref(user_id, name, namespace)
        .await
    {
        Ok(row) => row,
        Err(error) => {
            tracing::warn!(%error, name, "failed to build workspace: workspace read failed");
            return None;
        }
    }?;
    let json = row
        .get::<Json<OpaqueJson>>("json")
        .ok()
        .flatten()?
        .0
        .to_value();
    let repository = json.get("spec")?.get("repository")?;
    let text = |key: &str| {
        repository
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let branch = text("branchName");
    let repository = serde_json::json!({
        "gitUrl": text("gitUrl"),
        "gitRepo": text("gitRepo"),
        "gitRepoId": repository.get("gitRepoId").and_then(Value::as_i64).unwrap_or(0),
        "gitDomain": text("gitDomain"),
        "branchName": branch,
    });
    Some((repository, branch))
}

/// The task's stored project configuration, read inside
/// `_build_workspace_data`'s guard.
pub(super) async fn load_project_config<M: Mysql>(
    mysql: &M,
    project_id: i64,
    user_id: i64,
) -> Option<Value> {
    if project_id == 0 {
        return None;
    }
    let sql = format!(
        "SELECT {PROJECT_COLUMNS} \nFROM projects \n\
         WHERE projects.id = ? AND projects.user_id = ? \
         AND projects.is_active = true \n LIMIT 1"
    );
    let args = vec![StatementArg::Int(project_id), StatementArg::Int(user_id)];
    let row: Option<MysqlRow> = match mysql.fetch_optional(sql.as_str(), args).await {
        Ok(row) => row,
        Err(error) => {
            tracing::warn!(%error, project_id, "failed to build workspace: project read failed");
            return None;
        }
    };
    row.and_then(|row| {
        row.get::<Json<OpaqueJson>>("projects_config")
            .ok()
            .flatten()
            .map(|config| config.0.to_value())
    })
}

/// The project workspace entry `_merge_project_workspace` writes into
/// `workspace_data["project"]`, or `None` when the project is not a workspace
/// project (`not config.is_workspace or not config.execution`).
pub(super) fn project_workspace_entry(config: &Value, project_id: i64) -> Option<Value> {
    let config = config.as_object()?;
    if config.get("mode").and_then(Value::as_str) != Some("workspace") {
        return None;
    }
    // The Pydantic validator derives a local execution target from the legacy
    // `device_id` when `execution` is absent.
    let execution = match config.get("execution").and_then(Value::as_object) {
        Some(execution) => execution.clone(),
        None => {
            let device_id = config.get("device_id").and_then(Value::as_str)?;
            let mut execution = Map::new();
            execution.insert("targetType".into(), Value::String("local".into()));
            execution.insert("deviceId".into(), Value::String(device_id.to_string()));
            execution
        }
    };
    execution.get("targetType").and_then(Value::as_str)?;
    let device_id = execution.get("deviceId").cloned().unwrap_or(Value::Null);
    let target_type = execution.get("targetType").cloned().unwrap_or(Value::Null);

    let workspace = config.get("workspace").and_then(Value::as_object);
    let mut entry = Map::new();
    entry.insert("project_id".into(), Value::from(project_id));
    match workspace {
        Some(workspace) => {
            let source = workspace
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("local_path");
            let local_path = workspace.get("localPath").cloned();
            let checkout_path = workspace.get("checkoutPath").cloned();
            let device_path = workspace.get("devicePath").cloned();
            let project_workspace_path = match source {
                "git" => checkout_path
                    .as_ref()
                    .and_then(Value::as_str)
                    .filter(|path| !path.is_empty())
                    .map(|path| Value::String(format!("projects/{path}"))),
                "device_path" => device_path.clone(),
                _ => local_path.clone().or_else(|| checkout_path.clone()),
            };
            entry.insert("workspace_source".into(), Value::String(source.to_string()));
            entry.insert(
                "project_workspace_path".into(),
                project_workspace_path.unwrap_or(Value::Null),
            );
            entry.insert("execution_target_type".into(), target_type);
            entry.insert("device_id".into(), device_id);
            entry.insert("checkout_path".into(), checkout_path.unwrap_or(Value::Null));
            entry.insert("local_path".into(), local_path.unwrap_or(Value::Null));
            if source == "device_path" {
                entry.insert("device_path".into(), device_path.unwrap_or(Value::Null));
            }
        }
        None => {
            // Default workspace: the `project{id}` directory under the root.
            let default_path = format!("project{project_id}");
            entry.insert(
                "workspace_source".into(),
                Value::String("local_path".into()),
            );
            entry.insert(
                "project_workspace_path".into(),
                Value::String(default_path.clone()),
            );
            entry.insert("execution_target_type".into(), target_type);
            entry.insert("device_id".into(), device_id);
            entry.insert("checkout_path".into(), Value::Null);
            entry.insert("local_path".into(), Value::String(default_path));
        }
    }
    Some(Value::Object(entry))
}

/// The repository override `_merge_project_workspace` applies from the
/// project's git configuration.
pub(super) fn project_repository(config: &Value) -> Option<(Value, String)> {
    let git = config.get("git")?.as_object()?;
    let url = git.get("url").and_then(Value::as_str)?.to_string();
    let text = |key: &str| {
        git.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let branch = text("branch");
    let repository = serde_json::json!({
        "gitUrl": url,
        "gitRepo": text("repo"),
        "gitRepoId": git.get("repoId").and_then(Value::as_i64).unwrap_or(0),
        "gitDomain": text("domain"),
        "branchName": branch,
    });
    Some((repository, branch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_group_project_is_not_a_workspace_project() {
        // Recorded API source group: `{"taskSource": "api"}`.
        assert_eq!(
            project_workspace_entry(&serde_json::json!({"taskSource": "api"}), 2571),
            None
        );
        assert_eq!(project_workspace_entry(&serde_json::json!(null), 1), None);
    }

    #[test]
    fn workspace_project_without_workspace_config_uses_the_default_path() {
        let config = serde_json::json!({
            "mode": "workspace",
            "execution": {"targetType": "local"},
        });
        let entry = project_workspace_entry(&config, 42).expect("workspace project");
        assert_eq!(entry["project_id"], 42);
        assert_eq!(entry["workspace_source"], "local_path");
        assert_eq!(entry["project_workspace_path"], "project42");
        assert_eq!(entry["local_path"], "project42");
    }

    #[test]
    fn git_workspace_source_prefixes_the_checkout_path() {
        let config = serde_json::json!({
            "mode": "workspace",
            "execution": {"targetType": "cloud"},
            "workspace": {"source": "git", "checkoutPath": "owner/repo"},
            "git": {"url": "https://example/repo.git", "repo": "repo", "branch": "main"},
        });
        let entry = project_workspace_entry(&config, 7).expect("workspace project");
        assert_eq!(entry["workspace_source"], "git");
        assert_eq!(entry["project_workspace_path"], "projects/owner/repo");
        let (repository, branch) = project_repository(&config).expect("git config");
        assert_eq!(repository["gitUrl"], "https://example/repo.git");
        assert_eq!(branch, "main");
    }
}
