// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{env, ffi::OsString, process::Command as StdCommand};

use serde_json::json;

use super::*;
use crate::agents::git_workspace::tests::create_local_repository;

struct Fixture {
    root: tempfile::TempDir,
    saved: Vec<(&'static str, Option<OsString>)>,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let saved = [
            "HOME",
            "USERPROFILE",
            "WORKSPACE_ROOT",
            "WEGENT_EXECUTOR_HOME",
            "WECODE_HOME",
        ]
        .into_iter()
        .map(|key| {
            let saved = env::var_os(key);
            env::set_var(key, root.path().join(key));
            fs::create_dir_all(env::var_os(key).unwrap()).unwrap();
            (key, saved)
        })
        .collect();
        Self { root, saved }
    }

    fn request(&self, parent: &str) -> ExecutionRequest {
        let source =
            create_local_repository(&self.root.path().join(parent), "demo", "README.md", parent);
        ExecutionRequest {
            task_id: "42".into(),
            subtask_id: "43".into(),
            extra: serde_json::Map::from_iter([("git_url".into(), json!(source))]),
            ..ExecutionRequest::default()
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(value) => env::set_var(key, value),
                None => env::remove_var(key),
            }
        }
    }
}

fn git(path: &Path, args: &[&str]) {
    let mut command = StdCommand::new("git");
    crate::local::native_git::clear_local_git_env(&mut command);
    let output = command.arg("-C").arg(path).args(args).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

async fn prepare_request(request: ExecutionRequest) -> Result<ExecutionRequest, String> {
    let url = request.git_url().unwrap();
    prepare(request, &url, "demo").await
}

fn with_environment(test: impl std::future::Future<Output = ()>) {
    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(test);
}

#[test]
fn collision_extends_key_and_reuses_it_even_when_short_key_becomes_free() {
    with_environment(async {
        let fixture = Fixture::new();
        let request = fixture.request("source");
        let identity = RepositoryIdentity::from_url(&request.git_url().unwrap()).unwrap();
        let root = workspace_root();
        let short = root.join(identity.key(8));
        fs::write(&short, "unmanaged data").unwrap();
        let prepared = prepare_request(request.clone()).await.unwrap();
        assert_eq!(
            prepared.project_workspace_path.as_deref(),
            root.join(identity.key(12)).to_str()
        );
        assert_eq!(fs::read_to_string(&short).unwrap(), "unmanaged data");
        fs::rename(&short, root.join("preserved-data")).unwrap();
        assert_eq!(
            prepare_request(request)
                .await
                .unwrap()
                .project_workspace_path,
            prepared.project_workspace_path
        );
    });
}

#[test]
fn same_name_sources_are_separate_and_existing_wrong_remote_is_preserved() {
    with_environment(async {
        let fixture = Fixture::new();
        let first = fixture.request("git-one");
        let mut second = fixture.request("git-two");
        second.task_id = "44".into();
        let (one, two) = tokio::join!(
            prepare_request(first.clone()),
            prepare_request(second.clone())
        );
        let one = one.unwrap();
        let two = two.unwrap();
        assert_ne!(one.project_workspace_path, two.project_workspace_path);
        let path = Path::new(one.project_workspace_path.as_ref().unwrap());
        git(
            path,
            &["remote", "set-url", "origin", &second.git_url().unwrap()],
        );
        fs::write(path.join("uncommitted"), "retain").unwrap();
        assert!(prepare_request(first.clone())
            .await
            .unwrap_err()
            .contains("another Git repository"));
        let mut next = first;
        next.task_id = "45".into();
        let new = prepare_request(next).await.unwrap();
        assert_ne!(new.project_workspace_path, one.project_workspace_path);
        assert_eq!(
            fs::read_to_string(path.join("uncommitted")).unwrap(),
            "retain"
        );
    });
}

#[test]
fn legacy_binding_is_reused_and_mismatched_origin_is_rejected() {
    with_environment(async {
        let fixture = Fixture::new();
        let request = fixture.request("source");
        let path = resolve_git_project_path(&request, "demo");
        clone_repo(&request, &request.git_url().unwrap(), &path)
            .await
            .unwrap();
        fs::write(path.join("uncommitted"), "retain").unwrap();
        assert_eq!(
            prepare_request(request.clone())
                .await
                .unwrap()
                .project_workspace_path
                .as_deref(),
            path.to_str()
        );
        git(
            &path,
            &[
                "remote",
                "set-url",
                "origin",
                "https://other.invalid/group/demo",
            ],
        );
        assert!(prepare_request(request)
            .await
            .unwrap_err()
            .contains("another Git repository"));
        assert_eq!(
            fs::read_to_string(path.join("uncommitted")).unwrap(),
            "retain"
        );
    });
}

#[test]
fn missing_bound_repository_does_not_clone_a_replacement() {
    with_environment(async {
        let fixture = Fixture::new();
        let request = fixture.request("source");
        let prepared = prepare_request(request.clone()).await.unwrap();
        let path = Path::new(prepared.project_workspace_path.as_ref().unwrap());
        fs::write(path.join("uncommitted"), "retain").unwrap();
        let backup = fixture.root.path().join("detached-checkout");
        fs::rename(path, &backup).unwrap();
        assert!(prepare_request(request)
            .await
            .unwrap_err()
            .contains("Task repository is missing"));
        assert!(!path.exists());
        assert_eq!(
            fs::read_to_string(backup.join("uncommitted")).unwrap(),
            "retain"
        );
    });
}

#[test]
fn historical_device_root_requires_explicit_selection_then_reuses_in_place() {
    with_environment(async {
        let fixture = Fixture::new();
        let request = fixture.request("source");
        let old_root = PathBuf::from(env::var_os("WECODE_HOME").unwrap())
            .join("wegent-executor/workspace/projects");
        let path = old_root.join("42/demo");
        clone_repo(&request, &request.git_url().unwrap(), &path)
            .await
            .unwrap();
        fs::write(path.join("uncommitted"), "retain").unwrap();
        assert!(prepare_request(request.clone())
            .await
            .unwrap_err()
            .contains("Historical task workspace exists"));
        assert_eq!(fs::read_dir(workspace_root()).unwrap().count(), 0);
        env::set_var("WORKSPACE_ROOT", &old_root);
        let prepared = prepare_request(request).await.unwrap();
        assert_eq!(prepared.project_workspace_path.as_deref(), path.to_str());
        assert_eq!(task_repository::read("42").unwrap().unwrap().path(), path);
        assert_eq!(
            fs::read_to_string(path.join("uncommitted")).unwrap(),
            "retain"
        );
    });
}

#[test]
fn saved_session_without_workspace_does_not_create_fresh_code() {
    with_environment(async {
        let fixture = Fixture::new();
        let mut request = fixture.request("source");
        request.bot = json!({"id": 1, "shell_type": "ClaudeCode"});
        crate::agent_session::save_session_id(&request, "synthetic-session");
        assert!(crate::agent_session::saved_executor_session(&request).is_some());
        assert!(prepare_request(request)
            .await
            .unwrap_err()
            .contains("Existing task session has no workspace binding"));
    });
}

#[test]
fn historical_task_survives_metadata_migration_and_archives_once() {
    with_environment(async {
        use crate::envd::archive::{
            create_runtime_archive_with_repository, ArchiveMode, ArchiveOptions,
        };
        let fixture = Fixture::new();
        let request = fixture.request("source");
        let path = resolve_git_project_path(&request, "demo");
        clone_repo(&request, &request.git_url().unwrap(), &path)
            .await
            .unwrap();
        fs::create_dir(workspace_root().join(".repository-tasks")).unwrap();
        fs::write(path.join("uncommitted"), "retain").unwrap();
        let first = prepare_request(request.clone()).await.unwrap();
        let binding = task_repository::read("42").unwrap().unwrap();
        assert_eq!(binding.key, "42/demo");
        metadata::migrate(&workspace_root()).unwrap();
        for _ in 0..2 {
            assert_eq!(
                prepare_request(request.clone())
                    .await
                    .unwrap()
                    .project_workspace_path,
                first.project_workspace_path
            );
            assert_eq!(
                task_repository::resolve_api_path("/workspace/42").unwrap(),
                path
            );
        }
        let archive = create_runtime_archive_with_repository(
            ArchiveOptions {
                mode: ArchiveMode::Executor,
                task_id: "42".into(),
                workspace_path: workspace_root().join("42"),
                home_path: fixture.root.path().join("empty-home"),
                max_size_bytes: 1024 * 1024,
            },
            None,
        )
        .unwrap();
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive.bytes.as_slice()));
        let count = tar
            .entries()
            .unwrap()
            .filter(|entry| {
                entry.as_ref().unwrap().path().unwrap() == Path::new("workspace/demo/uncommitted")
            })
            .count();
        assert_eq!(count, 1);
        assert_eq!(
            fs::read_to_string(path.join("uncommitted")).unwrap(),
            "retain"
        );
    });
}

#[test]
fn clone_uses_requested_branch_but_new_tasks_and_followups_preserve_current_branch() {
    with_environment(async {
        let fixture = Fixture::new();
        let mut request = fixture.request("source");
        git(
            Path::new(&request.git_url().unwrap()),
            &["branch", "requested"],
        );
        request
            .extra
            .insert("branch_name".into(), json!("requested"));
        request.workspace_source = Some("current_workspace".into());
        let prepared = prepare_request(request.clone()).await.unwrap();
        let path = Path::new(prepared.project_workspace_path.as_ref().unwrap());
        assert_eq!(
            git_value(path, &["symbolic-ref", "HEAD"])
                .await
                .unwrap()
                .as_deref(),
            Some("refs/heads/requested")
        );
        git(path, &["checkout", "-b", "active"]);
        fs::write(path.join("uncommitted"), "retain").unwrap();
        for task_id in ["42", "99"] {
            let mut next = request.clone();
            next.task_id = task_id.into();
            assert_eq!(
                prepare_request(next).await.unwrap().project_workspace_path,
                prepared.project_workspace_path
            );
        }
        assert_eq!(
            git_value(path, &["symbolic-ref", "HEAD"])
                .await
                .unwrap()
                .as_deref(),
            Some("refs/heads/active")
        );
        fs::write(path.join(".git/HEAD"), "ref: refs/heads/unborn\n").unwrap();
        assert!(prepare_request(request).await.is_err());
        assert_eq!(
            fs::read_to_string(path.join("uncommitted")).unwrap(),
            "retain"
        );
    });
}

#[test]
fn explicit_worktree_keeps_its_own_head_and_does_not_switch_the_main_checkout() {
    with_environment(async {
        let fixture = Fixture::new();
        let mut request = fixture.request("source");
        let source = PathBuf::from(request.git_url().unwrap());
        git(&source, &["branch", "requested"]);
        git(&source, &["checkout", "-b", "active"]);
        let worktree = fixture.root.path().join("selected-worktree");
        git(
            &source,
            &[
                "worktree",
                "add",
                "--detach",
                worktree.to_str().unwrap(),
                "requested",
            ],
        );
        fs::write(worktree.join("uncommitted"), "retain").unwrap();
        request.project_workspace_path = Some(worktree.display().to_string());
        request.workspace_source = Some("git_worktree".into());
        request.extra.insert("branch_name".into(), json!("active"));
        let prepared = crate::agents::git_workspace::prepare_git_workspace(request)
            .await
            .unwrap();
        assert_eq!(
            prepared.project_workspace_path.as_deref(),
            worktree.to_str()
        );
        assert_eq!(
            git_value(&worktree, &["symbolic-ref", "--quiet", "HEAD"])
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            git_value(&source, &["symbolic-ref", "HEAD"])
                .await
                .unwrap()
                .as_deref(),
            Some("refs/heads/active")
        );
        assert_eq!(
            fs::read_to_string(worktree.join("uncommitted")).unwrap(),
            "retain"
        );
    });
}

#[test]
fn failed_clone_does_not_publish_partial_checkout_or_leave_staging() {
    with_environment(async {
        let fixture = Fixture::new();
        let mut request = fixture.request("source");
        request
            .extra
            .insert("branch_name".into(), json!("missing-branch"));
        assert!(prepare_request(request).await.is_err());
        assert_eq!(fs::read_dir(workspace_root()).unwrap().count(), 0);
    });
}

#[test]
fn task_alias_and_archive_preserve_code_and_task_local_attachments() {
    with_environment(async {
        use crate::{
            envd::archive::{
                create_runtime_archive_with_repository, restore_runtime_archive, ArchiveMode,
                ArchiveOptions,
            },
            workspace_paths::task_repository,
        };
        let fixture = Fixture::new();
        let request = fixture.request("source");
        let prepared = prepare_request(request.clone()).await.unwrap();
        let repository = Path::new(prepared.project_workspace_path.as_ref().unwrap());
        let binding = task_repository::read("42").unwrap().unwrap();
        assert_eq!(binding.path(), repository);
        assert_eq!(
            task_repository::resolve_api_path("/workspace/42").unwrap(),
            repository
        );
        let task = workspace_root().join("42");
        fs::create_dir_all(task.join("attachments")).unwrap();
        fs::write(task.join("attachments/input.txt"), "attachment").unwrap();
        fs::write(repository.join("uncommitted"), "retain").unwrap();
        fs::write(repository.join("README.md"), "tracked edit").unwrap();
        assert_eq!(
            task_repository::resolve_api_path("/workspace/42/attachments/input.txt").unwrap(),
            task.join("attachments/input.txt")
        );
        let lease = acquire_execution_lease(&request).unwrap();
        assert!(acquire_archive_lease(repository).await.is_err());
        drop(lease);
        let _lease = acquire_archive_lease(repository).await.unwrap();
        let archive = create_runtime_archive_with_repository(
            ArchiveOptions {
                mode: ArchiveMode::Executor,
                task_id: "42".into(),
                workspace_path: task,
                home_path: fixture.root.path().join("empty-runtime"),
                max_size_bytes: 1024 * 1024,
            },
            Some((repository, &binding.name)),
        )
        .unwrap();
        assert!(archive.git_included);
        let restored = fixture.root.path().join("restored");
        env::set_var("WORKSPACE_ROOT", &restored);
        let result = restore_runtime_archive(
            &archive.bytes,
            ArchiveMode::Executor,
            "42",
            &restored.join("42"),
            &fixture.root.path().join("restored-home"),
        )
        .unwrap();
        assert!(result.git_restored);
        let mut recovery_request = request;
        recovery_request.skip_git_clone = true;
        let resumed = crate::agents::git_workspace::prepare_git_workspace(recovery_request.clone())
            .await
            .unwrap();
        assert_eq!(
            resumed.project_workspace_path.as_deref(),
            restored.join(&binding.key).to_str()
        );
        assert_eq!(task_repository::read("42").unwrap().unwrap(), binding);
        assert!(!restored.join("42/demo").exists());
        assert_eq!(
            fs::read_to_string(restored.join(&binding.key).join("uncommitted")).unwrap(),
            "retain"
        );
        assert_eq!(
            fs::read_to_string(restored.join(&binding.key).join("README.md")).unwrap(),
            "tracked edit"
        );
        assert_eq!(
            fs::read_to_string(restored.join("42/attachments/input.txt")).unwrap(),
            "attachment"
        );
        assert!(repository.join("uncommitted").exists());
        let lease = acquire_execution_lease(&recovery_request).unwrap();
        assert!(lease.is_some());
        assert!(acquire_archive_lease(&restored.join(&binding.key))
            .await
            .is_err());
        drop(lease);

        // Repeated backup/restore must keep the same binding, not introduce a task directory.
        let next_archive = create_runtime_archive_with_repository(
            ArchiveOptions {
                mode: ArchiveMode::Executor,
                task_id: "42".into(),
                workspace_path: restored.join("42"),
                home_path: fixture.root.path().join("restored-home"),
                max_size_bytes: 1024 * 1024,
            },
            Some((&restored.join(&binding.key), &binding.name)),
        )
        .unwrap();
        let next_root = fixture.root.path().join("restored-again");
        env::set_var("WORKSPACE_ROOT", &next_root);
        restore_runtime_archive(
            &next_archive.bytes,
            ArchiveMode::Executor,
            "42",
            &next_root.join("42"),
            &fixture.root.path().join("next-home"),
        )
        .unwrap();
        assert_eq!(
            crate::agents::git_workspace::prepare_git_workspace(recovery_request)
                .await
                .unwrap()
                .project_workspace_path,
            Some(next_root.join(&binding.key).display().to_string())
        );
    });
}

#[test]
fn tag_checkout_can_be_reused_and_invalid_task_binding_is_rejected() {
    with_environment(async {
        use crate::workspace_paths::task_repository;
        let fixture = Fixture::new();
        let mut request = fixture.request("source");
        git(Path::new(&request.git_url().unwrap()), &["tag", "release"]);
        request.extra.insert("branch_name".into(), json!("release"));
        let first = prepare_request(request.clone()).await.unwrap();
        assert_eq!(
            prepare_request(request)
                .await
                .unwrap()
                .project_workspace_path,
            first.project_workspace_path
        );
        let marker = workspace_root().join(".wegent/tasks/42.json");
        fs::write(&marker, r#"{"key":"../outside","name":"demo"}"#).unwrap();
        assert!(task_repository::read("42").is_err());
        assert!(task_repository::resolve_api_path("/workspace/42").is_err());
        assert!(task_repository::read("../42").is_err());
    });
}

#[test]
fn execution_lease_excludes_same_repository_and_releases_on_drop() {
    let _lock = crate::test_env::lock();
    let fixture = Fixture::new();
    let request = fixture.request("source");
    let lease = acquire_execution_lease(&request).unwrap().unwrap();
    let mut next = request.clone();
    next.task_id = "99".into();
    assert!(acquire_execution_lease(&next).is_err());
    assert!(acquire_execution_lease(&fixture.request("other"))
        .unwrap()
        .is_some());
    next.project_workspace_path = Some(fixture.root.path().join("worktree").display().to_string());
    assert!(acquire_execution_lease(&next).unwrap().is_none());
    drop(lease);
    assert!(acquire_execution_lease(&request).unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn symlink_candidate_is_not_followed() {
    with_environment(async {
        let fixture = Fixture::new();
        let request = fixture.request("source");
        let source = request.git_url().unwrap();
        let identity = RepositoryIdentity::from_url(&source).unwrap();
        std::os::unix::fs::symlink(&source, workspace_root().join(identity.key(8))).unwrap();
        let prepared = prepare_request(request).await.unwrap();
        assert_eq!(
            prepared.project_workspace_path.as_deref(),
            workspace_root().join(identity.key(12)).to_str()
        );
        assert!(workspace_root().join(identity.key(8)).is_symlink());
    });
}
