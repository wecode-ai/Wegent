// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::process::{Command as StdCommand, Output};

use super::*;
use serde_json::json;

#[test]
fn expands_platform_home_relative_paths() {
    let _lock = crate::test_env::lock();
    let home = home_dir().expect("test user has a home directory");
    assert_eq!(expand_tilde("~"), home);
    assert_eq!(expand_tilde("~/test/SKILL.md"), home.join("test/SKILL.md"));
    let windows_path = r"~\test\SKILL.md";
    let expected = if cfg!(windows) {
        home.join(r"test\SKILL.md")
    } else {
        PathBuf::from(windows_path)
    };
    assert_eq!(expand_tilde(windows_path), expected);
    assert_eq!(
        expand_tilde("./test/SKILL.md"),
        PathBuf::from("./test/SKILL.md")
    );
}

fn run_test_git(command: &mut StdCommand) -> Output {
    clear_local_git_env(command);
    command.output().unwrap()
}

fn assert_test_git_success(description: &str, command: &mut StdCommand) {
    let output = run_test_git(command);
    assert!(
        output.status.success(),
        "{description} failed with status {}:\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

pub(super) fn create_local_repository(
    root: &Path,
    name: &str,
    file_name: &str,
    contents: &str,
) -> PathBuf {
    let repository = root.join(name);
    fs::create_dir_all(&repository).unwrap();
    assert_test_git_success(
        "git init",
        StdCommand::new("git").arg("init").arg(&repository),
    );
    fs::write(repository.join(file_name), contents).unwrap();
    assert_test_git_success(
        "git add",
        StdCommand::new("git")
            .arg("-C")
            .arg(&repository)
            .args(["add", "."]),
    );
    assert_test_git_success(
        "git commit",
        StdCommand::new("git").arg("-C").arg(&repository).args([
            "-c",
            "user.name=Wegent Test",
            "-c",
            "user.email=wegent@example.com",
            "commit",
            "-m",
            "initial",
        ]),
    );
    repository
}

#[test]
fn clones_and_reuses_repositories_beyond_windows_max_path() {
    let _lock = crate::test_env::lock();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let directory = tempfile::tempdir().unwrap();
        let source = create_local_repository(directory.path(), "source", "fixture.txt", "fixture");
        // Match the CI clone boundary: repository discovery fits MAX_PATH,
        // while Git's hook template paths require long-path support.
        let destination = directory
            .path()
            .join("r".repeat(236 - directory.path().to_string_lossy().len() - 1));
        assert!(
            destination
                .join(".git/hooks/fsmonitor-watchman.sample")
                .to_string_lossy()
                .len()
                > 260
        );

        clone_repo(
            &ExecutionRequest::default(),
            source.to_str().unwrap(),
            &destination,
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read_to_string(destination.join("fixture.txt")).unwrap(),
            "fixture"
        );
        assert_test_git_success(
            "git status after long-path clone",
            StdCommand::new("git")
                .arg("-C")
                .arg(&destination)
                .args(["status", "--porcelain"]),
        );
        #[cfg(windows)]
        {
            let output = run_test_git(
                StdCommand::new("git")
                    .arg("-C")
                    .arg(&destination)
                    .args(["config", "core.longpaths"]),
            );
            assert!(output.status.success());
            assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "true");
        }
    });
}

#[test]
fn unified_workspace_clones_reuses_and_exposes_the_same_logical_tree() {
    let _lock = crate::test_env::lock();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir(&home).unwrap();
        let keys = [
            "HOME",
            "USERPROFILE",
            "WORKSPACE_ROOT",
            "WEGENT_WORKSPACE_ROOT",
            "LOCAL_WORKSPACE_ROOT",
            "WEGENT_EXECUTOR_PROJECTS_DIR",
            "WEGENT_EXECUTOR_HOME",
            "EXECUTOR_MODE",
        ];
        struct Restore(Vec<(&'static str, Option<std::ffi::OsString>)>);
        impl Drop for Restore {
            fn drop(&mut self) {
                for (key, value) in &self.0 {
                    match value {
                        Some(value) => env::set_var(key, value),
                        None => env::remove_var(key),
                    }
                }
            }
        }
        let _restore = Restore(
            keys.into_iter()
                .map(|key| {
                    let old = env::var_os(key);
                    env::remove_var(key);
                    (key, old)
                })
                .collect(),
        );
        env::set_var("HOME", &home);
        env::set_var("USERPROFILE", &home);
        env::set_var("EXECUTOR_MODE", "docker");
        let source =
            create_local_repository(temp.path(), "demo", "README.md", "synthetic repository");
        let request = ExecutionRequest {
            task_id: "564".into(),
            subtask_id: "894".into(),
            extra: serde_json::Map::from_iter([(
                "git_url".into(),
                json!(source.display().to_string()),
            )]),
            ..ExecutionRequest::default()
        };
        let identity =
            crate::repository_identity::RepositoryIdentity::from_url(source.to_str().unwrap())
                .unwrap();
        let expected = home.join(".wegent").join("workspace").join(identity.key(8));
        let prepared = prepare_git_workspace(request.clone()).await.unwrap();
        assert_eq!(
            prepared.project_workspace_path.as_deref(),
            expected.to_str()
        );
        assert_eq!(
            fs::read_to_string(expected.join("README.md")).unwrap(),
            "synthetic repository"
        );
        let logical_name = format!("/workspace/{}", identity.key(8));
        let logical = crate::workspace_paths::resolve_logical_path(&logical_name);
        assert_eq!(logical, expected);
        fs::write(expected.join("uncommitted.txt"), "retain on next turn").unwrap();
        prepare_git_workspace(request.clone()).await.unwrap();
        assert_eq!(
            fs::read_to_string(expected.join("uncommitted.txt")).unwrap(),
            "retain on next turn"
        );
        let mut next = request.clone();
        next.task_id = "565".into();
        let separate = prepare_git_workspace(next).await.unwrap();
        assert_eq!(
            prepared.project_workspace_path,
            separate.project_workspace_path
        );
        assert!(Path::new(separate.project_workspace_path.as_ref().unwrap())
            .join("uncommitted.txt")
            .exists());
        let mut explicit = request;
        explicit.project_workspace_path = Some(source.display().to_string());
        assert_eq!(
            prepare_git_workspace(explicit)
                .await
                .unwrap()
                .project_workspace_path
                .as_deref(),
            source.to_str()
        );
        assert_eq!(
            fs::read_to_string(source.join("README.md")).unwrap(),
            "synthetic repository"
        );
    });
}

#[test]
fn reads_multiple_execution_repositories_and_primary_workspace() {
    let environment_root = std::path::absolute("/workspace/environments/project-1").unwrap();
    let mut request = ExecutionRequest {
        project_workspace_path: Some(
            environment_root
                .join("wegent")
                .to_string_lossy()
                .into_owned(),
        ),
        ..ExecutionRequest::default()
    };
    request.extra.insert(
        "execution".to_owned(),
        json!({
            "workspace": {
                "repositories": [
                    {
                        "name": "Wegent",
                        "url": "https://github.com/wecode-ai/Wegent.git",
                        "ref": "main",
                        "path": "wegent",
                        "primary": true
                    },
                    {
                        "name": "SDK",
                        "url": "https://github.com/example/sdk.git",
                        "ref": "v2",
                        "path": "deps/sdk",
                        "primary": false
                    }
                ]
            }
        }),
    );

    let repositories = execution_repositories(&request).unwrap();

    assert_eq!(repositories.len(), 2);
    assert_eq!(repositories[0].path, PathBuf::from("wegent"));
    assert_eq!(repositories[1].path, PathBuf::from("deps/sdk"));
    assert_eq!(
        resolve_environment_root(&request, &repositories),
        environment_root
    );
}

#[test]
fn rejects_execution_repositories_without_exactly_one_primary() {
    let mut request = ExecutionRequest::default();
    request.extra.insert(
        "execution".to_owned(),
        json!({
            "workspace": {
                "repositories": [
                    {
                        "url": "https://github.com/example/one.git",
                        "path": "one",
                        "primary": false
                    },
                    {
                        "url": "https://github.com/example/two.git",
                        "path": "two",
                        "primary": false
                    }
                ]
            }
        }),
    );

    assert!(execution_repositories(&request).is_err());
}

#[test]
fn rejects_overlapping_execution_repository_paths() {
    let mut request = ExecutionRequest::default();
    request.extra.insert(
        "execution".to_owned(),
        json!({
            "workspace": {
                "repositories": [
                    {
                        "url": "https://github.com/example/one.git",
                        "path": "source",
                        "primary": true
                    },
                    {
                        "url": "https://github.com/example/two.git",
                        "path": "source/dependencies/two",
                        "primary": false
                    }
                ]
            }
        }),
    );

    assert!(execution_repositories(&request).is_err());
}

#[test]
fn ignores_a_prepared_workspace_path_that_is_not_the_primary_repository() {
    let _lock = crate::test_env::lock();
    let mut request = ExecutionRequest {
        task_id: "task-1".to_owned(),
        project_workspace_path: Some("/tmp/unrelated-workspace".to_owned()),
        ..ExecutionRequest::default()
    };
    request.extra.insert(
        "execution".to_owned(),
        json!({
            "workspace": {
                "repositories": [
                    {
                        "url": "https://github.com/example/one.git",
                        "path": "source",
                        "primary": true
                    }
                ]
            }
        }),
    );

    let repositories = execution_repositories(&request).unwrap();

    assert_eq!(
        resolve_environment_root(&request, &repositories),
        workspace_root().join("task-1").join("environment")
    );
}

#[tokio::test]
async fn prepares_multiple_local_repositories_in_one_environment() {
    let directory = tempfile::tempdir().unwrap();
    let sources = directory.path().join("sources");
    let environment_root = directory.path().join("environment");
    let primary = create_local_repository(&sources, "application", "app.txt", "application");
    let dependency = create_local_repository(&sources, "shared-sdk", "sdk.txt", "shared sdk");
    let mut request = ExecutionRequest {
        task_id: "task-1".to_owned(),
        ..ExecutionRequest::default()
    };
    request.extra.insert(
        "environment_root".to_owned(),
        Value::String(environment_root.display().to_string()),
    );
    request.extra.insert(
        "execution".to_owned(),
        json!({
            "workspace": {
                "repositories": [
                    {
                        "url": primary.display().to_string(),
                        "path": "application",
                        "primary": true
                    },
                    {
                        "url": dependency.display().to_string(),
                        "path": "dependencies/shared-sdk",
                        "primary": false
                    }
                ]
            }
        }),
    );

    let prepared = prepare_git_workspace(request).await.unwrap();

    assert_eq!(
        prepared.project_workspace_path.as_deref(),
        Some(environment_root.join("application").to_str().unwrap())
    );
    assert_eq!(
        prepared.runtime_workspace_roots,
        vec![
            environment_root.join("application").display().to_string(),
            environment_root
                .join("dependencies/shared-sdk")
                .display()
                .to_string(),
        ]
    );
    assert_eq!(
        fs::read_to_string(environment_root.join("application/app.txt")).unwrap(),
        "application"
    );
    assert_eq!(
        fs::read_to_string(environment_root.join("dependencies/shared-sdk/sdk.txt")).unwrap(),
        "shared sdk"
    );
}

#[tokio::test]
async fn reclones_a_workspace_left_behind_by_an_interrupted_clone() {
    let directory = tempfile::tempdir().unwrap();
    let source = create_local_repository(
        &directory.path().join("sources"),
        "application",
        "app.txt",
        "application",
    );
    let environment_root = directory.path().join("environment");
    let target = environment_root.join("application");
    // Mimic a clone interrupted right after `git init`: `.git` exists but
    // holds no commits, so HEAD^{commit} can never resolve.
    fs::create_dir_all(&target).unwrap();
    assert_test_git_success("git init", StdCommand::new("git").arg("init").arg(&target));
    let mut request = ExecutionRequest {
        task_id: "task-1".to_owned(),
        ..ExecutionRequest::default()
    };
    request.extra.insert(
        "environment_root".to_owned(),
        Value::String(environment_root.display().to_string()),
    );
    request.extra.insert(
        "execution".to_owned(),
        json!({
            "workspace": {
                "repositories": [
                    {
                        "url": source.display().to_string(),
                        "path": "application",
                        "primary": true
                    }
                ]
            }
        }),
    );

    let prepared = prepare_git_workspace(request).await.unwrap();

    assert_eq!(
        prepared.project_workspace_path.as_deref(),
        Some(target.to_str().unwrap())
    );
    assert_eq!(
        fs::read_to_string(target.join("app.txt")).unwrap(),
        "application"
    );
    assert_test_git_success(
        "git rev-parse",
        StdCommand::new("git").arg("-C").arg(&target).args([
            "rev-parse",
            "--verify",
            "HEAD^{commit}",
        ]),
    );
}

#[test]
fn repo_name_supports_https_and_ssh_urls() {
    assert_eq!(
        repo_name_from_url("https://github.com/wecode-ai/wegent.git"),
        "wegent"
    );
    assert_eq!(
        repo_name_from_url("git@gitlab.com:group/project.git"),
        "project"
    );
}

#[test]
fn configured_https_repositories_require_credentials() {
    let protected_domains = vec!["github.com".to_owned()];

    assert!(requires_credentials_for_clone_with_domains(
        "https://github.com/wecode-ai/wegent.git",
        &protected_domains
    ));
    assert!(!requires_credentials_for_clone_with_domains(
        "https://gitlab.com/wecode-ai/wegent.git",
        &protected_domains
    ));
    assert!(!requires_credentials_for_clone_with_domains(
        "git@github.com:wecode-ai/wegent.git",
        &protected_domains
    ));
}

#[test]
fn device_local_transport_allows_configured_git_credential_helper() {
    let protected_domains = vec!["github.com".to_owned()];
    let server_request = ExecutionRequest::default();
    let device_request = ExecutionRequest {
        extra: serde_json::Map::from_iter([(
            "git_auth_transport".to_owned(),
            json!("device_local"),
        )]),
        ..ExecutionRequest::default()
    };
    let git_url = "https://github.com/wecode-ai/wegent.git";

    assert!(missing_required_task_git_credentials(
        &server_request,
        git_url,
        false,
        &protected_domains,
    ));
    assert!(!missing_required_task_git_credentials(
        &device_request,
        git_url,
        false,
        &protected_domains,
    ));
    assert!(!missing_required_task_git_credentials(
        &server_request,
        git_url,
        true,
        &protected_domains,
    ));
}

#[test]
fn http_git_urls_reject_embedded_credentials_and_queries() {
    assert!(git_url_contains_credentials(
        "https://octocat:token@github.com/org/repo.git"
    ));
    assert!(git_url_contains_credentials(
        "https://github.com/org/repo.git?token=secret"
    ));
    assert!(!git_url_contains_credentials(
        "https://github.com/org/repo.git"
    ));
    assert!(!git_url_contains_credentials("git@github.com:org/repo.git"));
}

#[test]
fn resolves_project_workspace_path_first() {
    let request = ExecutionRequest {
        task_id: "10".to_owned(),
        project_workspace_path: Some("projects/custom".to_owned()),
        extra: serde_json::Map::from_iter([("project_id".to_owned(), json!(99))]),
        ..ExecutionRequest::default()
    };

    assert!(resolve_git_project_path(&request, "repo").ends_with("projects/custom"));
}

#[test]
fn git_clone_failure_fields_include_diagnostics_without_credentials() {
    let mut fields = vec![("task_id", "10".to_owned())];
    push_git_clone_failure_fields(
        &mut fields,
        Some(128),
        "trace token ghp_secret",
        "fatal: Authentication failed for 'https://token:glpat-secret@gitlab.com/org/repo.git'",
    );

    assert!(fields.contains(&("exit_code", "128".to_owned())));
    assert!(fields
        .iter()
        .any(|(key, value)| *key == "stderr" && value.contains("Authentication failed")));
    assert!(!fields
        .iter()
        .any(|(_, value)| value.contains("glpat-secret")));
    assert!(!fields.iter().any(|(_, value)| value.contains("ghp_secret")));
}

#[test]
fn git_clone_diagnostics_keep_failure_after_a_long_destination_path() {
    let mut fields = Vec::new();
    let stderr = format!(
        "Cloning into '{}'/project...\nfatal: could not create work tree dir: Filename too long",
        "nested-directory/".repeat(30)
    );
    push_git_clone_failure_fields(&mut fields, Some(128), "", &stderr);
    assert!(fields
        .iter()
        .any(|(key, value)| *key == "stderr" && value.ends_with("Filename too long")));
}
