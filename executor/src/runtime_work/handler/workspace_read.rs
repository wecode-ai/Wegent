// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Read-only workspace operations for an opted-in remote task client.

use std::{collections::HashMap, fs, path::Path, time::Duration};

use serde_json::Value;

use super::*;
use crate::local::{
    command::{CommandHandler, CommandRequest, CommandResult},
    git_commands::branch_diff,
    native_git::run_git_capture,
    turn_file_changes_commands::turn_file_changes,
    workspace_files::execute_workspace_file_command,
};

const MAX_DIFF_BYTES: usize = 5 * 1024 * 1024;

impl RuntimeWorkRpcHandler {
    pub(super) async fn read_workspace(&self, payload: Value) -> Result<Value, AppIpcError> {
        let root = required_path(&payload, "root")?;
        let path = required_path(&payload, "path")?;
        let command_key = string_field(&payload, "commandKey")
            .ok_or_else(|| AppIpcError::new("bad_request", "commandKey is required"))?;
        if payload.get("taskId").is_some() && string_field(&payload, "taskId").is_none() {
            return Err(AppIpcError::new(
                "bad_request",
                "taskId must be a nonempty string",
            ));
        }
        if !path.starts_with(&root) || !self.remote_read_root_is_allowed(&root, &payload) {
            return Err(AppIpcError::new(
                "workspace_access_denied",
                "The requested path is outside the selected task or project workspace",
            ));
        }
        let args = match payload.get("args") {
            None => vec![],
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| item.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| AppIpcError::new("bad_request", "args must contain strings"))?,
            _ => return Err(AppIpcError::new("bad_request", "args must be an array")),
        };
        let path = path.to_string_lossy().into_owned();
        if command_key.starts_with("git_") && !git_repository_is_within(&root, &path).await {
            let result = if command_key == "git_is_worktree" {
                CommandResult::ok("false".to_owned())
            } else {
                CommandResult::error(
                    "Git repository is outside the selected workspace".to_owned(),
                    0.0,
                    false,
                )
            };
            return serde_json::to_value(result)
                .map_err(|error| AppIpcError::new("internal_error", error.to_string()));
        }
        let result = match command_key.as_str() {
            "workspace_tree" | "workspace_read_text_file" | "workspace_read_file_chunk" => {
                execute_workspace_file_command(&command_key, Some(path), args).await
            }
            "git_branch_diff" => {
                branch_diff(Some(path), &HashMap::new(), 30.0, MAX_DIFF_BYTES).await
            }
            "git_branch"
            | "git_is_worktree"
            | "git_diff_unstaged"
            | "git_diff_staged"
            | "git_diff_last_commit" => read_git(&command_key, path).await,
            "turn_file_changes_review" => {
                let artifact_id = args
                    .first()
                    .ok_or_else(|| AppIpcError::new("bad_request", "artifact id is required"))?;
                turn_file_changes(
                    "review",
                    artifact_id,
                    Some(&path),
                    &HashMap::new(),
                    MAX_DIFF_BYTES,
                )
                .await
            }
            "search" => {
                return self
                    .search_workspace_at_root(Path::new(&path), &payload)
                    .await;
            }
            _ => {
                return Err(AppIpcError::new(
                    "bad_request",
                    "Unsupported workspace read",
                ))
            }
        };
        serde_json::to_value(result)
            .map_err(|error| AppIpcError::new("internal_error", error.to_string()))
    }

    fn remote_read_root_is_allowed(&self, root: &Path, payload: &Value) -> bool {
        if let Some(task_id) = string_field(payload, "taskId") {
            return self.store.get_task_summary(&task_id).is_some_and(|task| {
                task.status != "archived"
                    && fs::canonicalize(task.workspace_path)
                        .is_ok_and(|path| root.starts_with(path))
            });
        }
        CodexGlobalProjectIndex::load()
            .projects()
            .iter()
            .filter(|project| project.active && project.source != "remote_project")
            .flat_map(|project| {
                std::iter::once(project.workspace_path.as_str())
                    .chain(project.roots.iter().map(String::as_str))
            })
            .filter_map(|path| fs::canonicalize(path).ok())
            .any(|path| root.starts_with(path))
    }
}

fn required_path(payload: &Value, field: &str) -> Result<std::path::PathBuf, AppIpcError> {
    let value = string_field(payload, field)
        .ok_or_else(|| AppIpcError::new("bad_request", format!("{field} is required")))?;
    let path = Path::new(&value);
    if !path.is_absolute() {
        return Err(AppIpcError::new(
            "bad_request",
            format!("{field} must be absolute"),
        ));
    }
    let path = fs::canonicalize(path)
        .map_err(|_| AppIpcError::new("invalid_workspace_path", "Workspace path is unavailable"))?;
    if !path.is_dir() {
        return Err(AppIpcError::new(
            "invalid_workspace_path",
            "Workspace path is not a directory",
        ));
    }
    Ok(path)
}

async fn read_git(command_key: &str, path: String) -> CommandResult {
    let argv: &[&str] = match command_key {
        "git_branch" => &["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
        "git_is_worktree" => &["git", "rev-parse", "--is-inside-work-tree"],
        "git_diff_unstaged" => &["git", "diff", "--binary", "--"],
        "git_diff_staged" => &["git", "diff", "--binary", "--cached", "--"],
        "git_diff_last_commit" => &["git", "diff", "--binary", "HEAD~1..HEAD", "--"],
        _ => unreachable!(),
    };
    CommandHandler
        .execute(CommandRequest {
            command_key: Some(command_key.to_owned()),
            command: argv.join(" "),
            argv: argv.iter().map(|arg| (*arg).to_owned()).collect(),
            cwd: Some(path),
            env: HashMap::new(),
            timeout_seconds: Duration::from_secs(30).as_secs_f64(),
            max_output_bytes: MAX_DIFF_BYTES,
        })
        .await
}

async fn git_repository_is_within(root: &Path, path: &str) -> bool {
    let args = ["rev-parse", "--show-toplevel"].map(str::to_owned);
    let Ok(result) = run_git_capture(
        &args,
        Some(Path::new(path)),
        &HashMap::new(),
        Duration::from_secs(10),
        4096,
    )
    .await
    else {
        return false;
    };
    result.success
        && std::str::from_utf8(&result.stdout)
            .ok()
            .and_then(|path| fs::canonicalize(path.trim()).ok())
            .is_some_and(|git_root| git_root.starts_with(root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_work::{response::RuntimeTaskLink, store::RuntimeWorkStore};
    use serde_json::json;
    use std::process::Command;

    #[tokio::test]
    async fn task_worktree_reads_stay_inside_the_current_worktree() {
        let root = tempfile::tempdir().unwrap();
        let worktree = root.path().join("worktree");
        let other = root.path().join("other");
        fs::create_dir_all(worktree.join("src")).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(worktree.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(other.join("private.txt"), "private").unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("device-1", "unused");
        handler.store = RuntimeWorkStore::new(root.path().join("task-index.json"));
        handler.store.upsert_task(RuntimeTaskLink::new_pending(
            "task-1".to_owned(),
            worktree.display().to_string(),
            "Task".to_owned(),
        ));
        let read = |path: &Path, command_key: &str, args: Vec<&str>| {
            json!({
                "root": worktree,
                "path": path,
                "taskId": "task-1",
                "commandKey": command_key,
                "args": args,
            })
        };
        let listing = handler
            .read_workspace(read(&worktree, "workspace_tree", vec![]))
            .await
            .unwrap();
        assert_eq!(listing["success"], true);
        let file = handler
            .read_workspace(read(
                &worktree.join("src"),
                "workspace_read_text_file",
                vec!["main.rs"],
            ))
            .await
            .unwrap();
        assert_eq!(file["stdout"]["content"], "fn main() {}");
        assert!(handler
            .read_workspace(read(&other, "workspace_tree", vec![]))
            .await
            .is_err());
        assert!(handler
            .read_workspace(read(&worktree, "workspace_write_text_file", vec![]))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn task_reads_use_the_actual_git_worktree_not_its_source_repository() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let worktree = root.path().join("task-worktree");
        fs::create_dir(&source).unwrap();
        let git = |directory: &Path, args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(directory)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&source, &["init", "-b", "main"]);
        fs::write(source.join("source-only.txt"), "source").unwrap();
        git(&source, &["add", "."]);
        git(
            &source,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "commit",
                "-m",
                "base",
            ],
        );
        git(
            &source,
            &[
                "worktree",
                "add",
                "-b",
                "mobile",
                worktree.to_str().unwrap(),
            ],
        );
        let mut handler = RuntimeWorkRpcHandler::new("device-1", "unused");
        handler.store = RuntimeWorkStore::new(root.path().join("task-index.json"));
        handler.store.upsert_task(RuntimeTaskLink::new_pending(
            "task-1".to_owned(),
            worktree.display().to_string(),
            "Task".to_owned(),
        ));
        let branch = handler
            .read_workspace(json!({
                "root": worktree,
                "path": worktree,
                "taskId": "task-1",
                "commandKey": "git_branch",
            }))
            .await
            .unwrap();
        assert_eq!(branch["stdout"].as_str().unwrap().trim(), "mobile");
        let source_read = handler
            .read_workspace(json!({
                "root": source,
                "path": source,
                "taskId": "task-1",
                "commandKey": "workspace_tree",
            }))
            .await;
        assert!(source_read.is_err());
    }
}
