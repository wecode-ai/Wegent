// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use sha2::{Digest, Sha256};
use std::{
    path::Path,
    process::{Command, Stdio},
};

use super::*;

impl LocalTaskStore {
    pub(crate) fn ensure_code_project(
        &self,
        key: &str,
        name: &str,
        roots: &[String],
        bound_local_id: Option<&str>,
    ) -> Result<(), TaskRuntimeError> {
        let id = format!("local-code-{:x}", Sha256::digest(key.as_bytes()));
        let execution_environment = code_project_execution_environment(roots);
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Archived projects remain tombstones; refreshing must not resurrect them.
        let bound_local_id = bound_local_id.filter(|id| *id != DEFAULT_WORK_ITEM_PROJECT_ID);
        let existing_id = transaction
            .query_row(
                "SELECT id FROM loop_items
             WHERE resource_type = 'project' AND (id = ?1 OR id = ?2)
             ORDER BY CASE WHEN id = ?2 THEN 0 ELSE 1 END
             LIMIT 1",
                params![id, bound_local_id,],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if existing_id.is_none() {
            let project_key = unused_project_key(&transaction)?;
            let mut metadata = local_project_metadata(TaskProviderKind::Local, json!({}));
            metadata["code_project_key"] = json!(key);
            metadata["workspace_roots"] = json!(roots);
            if let Some(environment) = execution_environment.as_ref() {
                metadata["execution_environment"] = environment.clone();
            }
            let timestamp = now();
            transaction.execute(
                "INSERT INTO loop_items (
                    id, resource_type, project_space, public_id, project_key, name,
                    storage_prefix, next_item_number, status, sort_order,
                    metadata, version, created_at, updated_at
                 ) VALUES (?1, 'project', 'default', ?1, ?2, ?3, ?4, 1, 'active',
                           0, ?5, 1, ?6, ?6)",
                params![
                    id,
                    project_key,
                    name,
                    format!("projects/{id}"),
                    metadata.to_string(),
                    timestamp
                ],
            )?;
        } else if let (Some(existing_id), Some(environment)) = (existing_id, execution_environment)
        {
            let metadata = transaction
                .query_row(
                    "SELECT metadata FROM loop_items
                     WHERE id = ?1 AND resource_type = 'project' AND deleted_at IS NULL",
                    [&existing_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if let Some(metadata) = metadata {
                let mut metadata =
                    serde_json::from_str::<Value>(&metadata).unwrap_or_else(|_| json!({}));
                if metadata.get("execution_environment").is_none() {
                    metadata["execution_environment"] = environment;
                    transaction.execute(
                        "UPDATE loop_items
                         SET metadata = ?1, version = version + 1, updated_at = ?2
                         WHERE id = ?3 AND resource_type = 'project' AND deleted_at IS NULL",
                        params![metadata.to_string(), now(), existing_id],
                    )?;
                }
            }
        }
        transaction.commit()?;
        Ok(())
    }
}

fn code_project_execution_environment(roots: &[String]) -> Option<Value> {
    let root = roots.first()?;
    let repository_root = git_output(root, &["rev-parse", "--show-toplevel"])?;
    let remote_url = git_output(&repository_root, &["remote", "get-url", "origin"])?;
    let branch = git_output(&repository_root, &["branch", "--show-current"]).unwrap_or_default();
    let repository_name = Path::new(&repository_root)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())?
        .to_owned();
    Some(json!({
        "repositories": [{
            "name": repository_name,
            "url": remote_url,
            "ref": branch,
            "path": repository_name,
            "primary": true,
        }],
        "setup_steps": [],
    }))
}

fn git_output(cwd: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    crate::local::native_git::clear_local_git_env(&mut command);
    let output = command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(repository: &Path, args: &[&str]) {
        let mut command = Command::new("git");
        crate::local::native_git::clear_local_git_env(&mut command);
        let status = command.args(args).current_dir(repository).status().unwrap();
        assert!(status.success(), "git command failed: {args:?}");
    }

    #[test]
    fn generated_code_project_records_primary_git_repository() {
        let home = tempfile::tempdir().unwrap();
        let repository = home.path().join("Wegent");
        std::fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-b", "main"]);
        git(
            &repository,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/wecode-ai/Wegent.git",
            ],
        );
        let store = LocalTaskStore::open(home.path().join("tasks.sqlite")).unwrap();

        store
            .ensure_code_project(
                "wegent",
                "Wegent",
                &[repository.display().to_string()],
                None,
            )
            .unwrap();

        let project = store
            .list_projects()
            .unwrap()
            .into_iter()
            .find(|project| project.metadata["code_project_key"] == "wegent")
            .unwrap();
        assert_eq!(
            project.metadata["execution_environment"],
            json!({
                "repositories": [{
                    "name": "Wegent",
                    "url": "https://github.com/wecode-ai/Wegent.git",
                    "ref": "main",
                    "path": "Wegent",
                    "primary": true,
                }],
                "setup_steps": [],
            })
        );
    }

    #[test]
    fn generated_code_project_backfills_git_repository_without_overwriting_configuration() {
        let home = tempfile::tempdir().unwrap();
        let repository = home.path().join("Wegent");
        std::fs::create_dir(&repository).unwrap();
        let store = LocalTaskStore::open(home.path().join("tasks.sqlite")).unwrap();
        let roots = [repository.display().to_string()];

        store
            .ensure_code_project("wegent", "Wegent", &roots, None)
            .unwrap();
        let initial = store
            .list_projects()
            .unwrap()
            .into_iter()
            .find(|project| project.metadata["code_project_key"] == "wegent")
            .unwrap();
        assert!(initial.metadata.get("execution_environment").is_none());

        git(&repository, &["init", "-b", "main"]);
        git(
            &repository,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/wecode-ai/Wegent.git",
            ],
        );
        store
            .ensure_code_project("wegent", "Wegent", &roots, None)
            .unwrap();
        let backfilled = store
            .list_projects()
            .unwrap()
            .into_iter()
            .find(|project| project.metadata["code_project_key"] == "wegent")
            .unwrap();
        assert_eq!(
            backfilled.metadata["execution_environment"]["repositories"][0]["url"],
            "https://github.com/wecode-ai/Wegent.git"
        );

        store
            .update_project(
                &backfilled.id,
                ProjectUpdate {
                    version: backfilled.version,
                    execution_environment: Some(json!({
                        "repositories": [{
                            "name": "Custom",
                            "url": "https://example.com/custom.git",
                            "ref": "release",
                            "path": "custom",
                            "primary": true,
                        }],
                        "setup_steps": [],
                    })),
                    ..ProjectUpdate::default()
                },
            )
            .unwrap();
        store
            .ensure_code_project("wegent", "Wegent", &roots, None)
            .unwrap();
        let preserved = store
            .list_projects()
            .unwrap()
            .into_iter()
            .find(|project| project.metadata["code_project_key"] == "wegent")
            .unwrap();
        assert_eq!(
            preserved.metadata["execution_environment"]["repositories"][0]["url"],
            "https://example.com/custom.git"
        );
    }

    #[test]
    fn generated_code_project_updates_the_bound_collaboration_project() {
        let home = tempfile::tempdir().unwrap();
        let repository = home.path().join("Wegent");
        std::fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-b", "main"]);
        git(
            &repository,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/wecode-ai/Wegent.git",
            ],
        );
        let store = LocalTaskStore::open(home.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "Bound collaboration project".to_owned(),
                project_key: None,
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();

        store
            .ensure_code_project(
                "wegent",
                "Wegent",
                &[repository.display().to_string()],
                Some(&project.id),
            )
            .unwrap();

        let projects = store.list_projects().unwrap();
        let bound = projects
            .iter()
            .find(|candidate| candidate.id == project.id)
            .unwrap();
        assert_eq!(
            bound.metadata["execution_environment"]["repositories"][0]["url"],
            "https://github.com/wecode-ai/Wegent.git"
        );
        assert!(!projects
            .iter()
            .any(|candidate| candidate.metadata["code_project_key"] == "wegent"));
    }
}
