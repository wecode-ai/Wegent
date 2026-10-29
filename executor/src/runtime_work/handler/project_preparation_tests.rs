// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::super::project_preparation::{configure, DEFERRED_ENVIRONMENT};
use super::*;
use crate::local::environment_prepare::prepare_environment;

fn turn_with_setup(id: &str, command: &str) -> SpawnTurnRequest {
    let mut request = ExecutionRequest {
        task_id: id.into(),
        ..Default::default()
    };
    configure(
        &mut request,
        &json!({"execution": {"environment": {
            "environmentId": "project-1", "repositories": [],
            "setupSteps": [{"command": command, "workingDirectory": ""}]
        }}}),
    )
    .unwrap();
    SpawnTurnRequest {
        local_task_id: id.into(),
        runtime: "codex".into(),
        request,
        send_payload: None,
        direct_thread_id: None,
        fork_thread_id: None,
        fork_thread_path: None,
        resume_thread_id: None,
        initial_thread_goal: None,
    }
}

#[test]
fn project_preparation_is_shared_and_serialized_by_configuration() {
    let _lock = crate::test_env::lock();
    let temp = tempfile::tempdir().unwrap();
    let _env = ScalarEnv::set("WORKSPACE_ROOT", temp.path().to_str().unwrap());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let turn = turn_with_setup("first", "printf ready >> prepared.txt");
        let definition = &turn.request.extra[DEFERRED_ENVIRONMENT];
        let (first, second) = tokio::join!(
            prepare_environment(definition),
            prepare_environment(definition)
        );
        let first = first.unwrap();
        assert_eq!(first.cwd(), second.unwrap().cwd());
        assert_eq!(
            fs::read_to_string(Path::new(first.cwd().unwrap()).join("prepared.txt")).unwrap(),
            "ready"
        );
        let changed = turn_with_setup("next", "printf changed >> prepared.txt");
        assert_ne!(changed.request.cwd(), first.cwd());
    });
}

#[test]
fn project_preparation_failure_keeps_snapshot_and_retry_succeeds() {
    let _lock = crate::test_env::lock();
    let temp = tempfile::tempdir().unwrap();
    let _env = ScalarEnv::set("WORKSPACE_ROOT", temp.path().to_str().unwrap());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (handler, root) = isolated_runtime_work_handler("project-preparation-retry");
        let turn = turn_with_setup("retry", "test -f fixed && printf ready > result.txt");
        let path = PathBuf::from(turn.request.cwd().unwrap());
        let mut link = RuntimeTaskLink::new_pending(
            "retry".into(),
            path.display().to_string(),
            "Retry".into(),
        );
        store_runtime_execution_request(&mut link.runtime_handle, &turn.request);
        handler.upsert_local_task(link);
        handler.reserve_worktree_preparation(&turn);
        let error = handler
            .prepare_and_start_reserved_turn(turn.clone())
            .await
            .unwrap_err();
        assert!(error.message.contains("setup command 1 exited"));
        assert!(turn.request.extra.contains_key(DEFERRED_ENVIRONMENT));
        let saved = handler.local_task_link("retry").unwrap();
        assert_eq!(saved.status, "failed");
        assert!(saved.thread_id.is_none());
        assert!(saved.runtime_handle["executionRequest"][DEFERRED_ENVIRONMENT].is_object());
        fs::write(path.join("fixed"), "").unwrap();
        let response = handler.send_message(json!({
            "taskId": "retry", "message": "retry preparation",
            "executionRequest": {"task_id": "retry", "subtask_id": "retry-turn", "prompt": "retry preparation"}
        })).await.unwrap();
        assert_eq!(response["accepted"], true, "{response}");
        tokio::time::timeout(Duration::from_secs(5), async {
            // The setup file precedes process exit and persistence of the prepared request.
            while handler.local_task_link("retry").unwrap().runtime_handle["executionRequest"][DEFERRED_ENVIRONMENT].is_object() {
                sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        assert_eq!(
            fs::read_to_string(path.join("result.txt")).unwrap(),
            "ready"
        );
        assert!(handler.local_task_link("retry").unwrap().runtime_handle["executionRequest"][DEFERRED_ENVIRONMENT].is_null());
        fs::remove_dir_all(root).unwrap();
    });
}

#[test]
fn project_preparation_clones_before_creating_independent_worktrees() {
    let _lock = crate::test_env::lock();
    let temp = tempfile::tempdir().unwrap();
    let _env = ScalarEnv::set("WORKSPACE_ROOT", temp.path().to_str().unwrap());
    let repo = temp.path().join("source");
    initialize_test_repository(&repo);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (handler, root) = isolated_runtime_work_handler("project-preparation-worktree");
        handler.worktrees.update_settings(WorktreeSettingsPatch {
            worktree_root: Some(temp.path().join("worktrees").display().to_string()), ..Default::default()
        }).unwrap();
        let mut paths = Vec::new();
        for id in ["first", "second"] {
            let mut turn = turn_with_setup(id, "");
            configure(&mut turn.request, &json!({"execution": {
                "workspace": {"source": "git_worktree"},
                "environment": {"environmentId": "repository-project", "repositories": [
                    {"name": "repo", "url": repo.display().to_string(), "path": "repo", "primary": true}
                ], "setupSteps": []}
            }})).unwrap();
            let base = turn.request.cwd().unwrap().to_owned();
            handler.prepare_project_environment(&mut turn).await.unwrap();
            handler.prepare_deferred_worktree(&mut turn).await.unwrap();
            let path = turn.request.cwd().unwrap();
            assert_ne!(path, base);
            assert!(Path::new(path).join("tracked.txt").is_file());
            assert!(turn.request.runtime_workspace_roots.contains(&path.to_owned()));
            assert!(!turn.request.runtime_workspace_roots.contains(&base));
            paths.push(path.to_owned());
        }
        assert_ne!(paths[0], paths[1]);
        fs::remove_dir_all(root).unwrap();
    });
}

#[test]
fn deferred_worktree_rebases_project_roots_using_path_identity() {
    let _lock = crate::test_env::lock();
    let temp = tempfile::tempdir().unwrap();
    let _env = ScalarEnv::set("WORKSPACE_ROOT", temp.path().to_str().unwrap());
    let repo = temp.path().join("source");
    let dependency = temp.path().join("dependency");
    initialize_test_repository(&repo);
    fs::create_dir(&dependency).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (handler, root) = isolated_runtime_work_handler("worktree-permission-roots");
        handler
            .worktrees
            .update_settings(WorktreeSettingsPatch {
                worktree_root: Some(temp.path().join("worktrees").display().to_string()),
                ..Default::default()
            })
            .unwrap();
        let plan = handler
            .worktrees
            .plan(&repo, "permission-roots", None)
            .unwrap();
        let source = plan.source_path.display().to_string();
        let alias = if cfg!(windows) {
            let plain = crate::path_compat::strip_windows_verbatim_prefix(Path::new(&source));
            format!("{}\\", plain.display().to_string().replace('/', "\\"))
        } else {
            format!("{source}/")
        };
        let mut turn = turn_with_setup("permission-roots", "");
        turn.request.extra.remove(DEFERRED_ENVIRONMENT);
        turn.request
            .extra
            .insert("deferred_worktree_source_path".into(), json!(source));
        turn.request.runtime_workspace_roots = vec![alias, dependency.display().to_string()];
        handler.prepare_deferred_worktree(&mut turn).await.unwrap();
        assert_eq!(
            turn.request.runtime_workspace_roots,
            vec![
                turn.request.cwd().unwrap().to_owned(),
                dependency.display().to_string()
            ]
        );
        fs::remove_dir_all(root).unwrap();
    });
}

#[test]
fn project_preparation_accepts_without_blocking_and_can_be_cancelled() {
    let _lock = crate::test_env::lock();
    let temp = tempfile::tempdir().unwrap();
    let _env = ScalarEnv::set("WORKSPACE_ROOT", temp.path().to_str().unwrap());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (handler, root) = isolated_runtime_work_handler("project-preparation-cancel");
        let payload = json!({"runtime":"codex", "taskId":"cancel-preparation", "message":"test",
            "executionRequest": {"task_id":"cancel-preparation", "subtask_id":"first", "prompt":"test"},
            "execution":{"environment":{"environmentId":"cancel-project", "repositories":[],
                "setupSteps":[{"command":"printf started > started; while :; do sleep 1; done", "workingDirectory":""}]}}
        });
        let response = tokio::time::timeout(Duration::from_secs(5), handler.create_task(payload)).await.unwrap().unwrap();
        assert_eq!(response["accepted"], true);
        assert_eq!(response["workspacePending"], true);
        assert_eq!(response["workspacePath"], "");
        let path = handler.local_task_link("cancel-preparation").unwrap().workspace_path;
        tokio::time::timeout(Duration::from_secs(5), async {
            while !Path::new(&path).join("started").is_file() {
                sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        assert!(handler.is_busy_local_task("cancel-preparation"));
        assert!(handler.cancel_preparing_worktree_turn("cancel-preparation"));
        assert!(handler.wait_for_worktree_preparation_to_finish("cancel-preparation").await);
        let link = handler.local_task_link("cancel-preparation").unwrap();
        assert_eq!(link.status, "cancelled");
        assert!(link.thread_id.is_none());
        assert!(!handler.is_busy_local_task("cancel-preparation"));
        fs::remove_dir_all(root).unwrap();
    });
}

#[test]
fn project_preparation_runs_for_restored_and_force_started_turns() {
    let _lock = crate::test_env::lock();
    let temp = tempfile::tempdir().unwrap();
    let _env = ScalarEnv::set("WORKSPACE_ROOT", temp.path().to_str().unwrap());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        for restored in [true, false] {
            let (handler, root) = isolated_runtime_work_handler(if restored {
                "restored-preparation"
            } else {
                "forced-preparation"
            });
            let mut turn = turn_with_setup("pending", "printf attempted > attempted; false");
            let path = PathBuf::from(turn.request.cwd().unwrap());
            let mut link = RuntimeTaskLink::new_pending(
                "pending".into(),
                path.display().to_string(),
                "Pending".into(),
            );
            store_runtime_execution_request(&mut link.runtime_handle, &turn.request);
            handler.upsert_local_task(link);
            if restored {
                turn.request
                    .extra
                    .insert(RESTORED_TURN_MARKER.into(), json!(true));
                handler.reserve_worktree_preparation(&turn);
                handler.start_queued_turn(turn);
            } else {
                handler.turn_scheduler.lock().unwrap().enqueue_queued(turn);
                let response = handler
                    .force_start_task(json!({"taskId":"pending"}))
                    .await
                    .unwrap();
                assert_eq!(response["accepted"], true);
            }
            tokio::time::timeout(Duration::from_secs(5), async {
                while handler.local_task_link("pending").unwrap().status != "failed" {
                    sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let link = handler.local_task_link("pending").unwrap();
            assert_eq!(
                fs::read_to_string(path.join("attempted")).unwrap(),
                "attempted"
            );
            assert!(link.thread_id.is_none());
            assert!(link.runtime_handle["executionRequest"][DEFERRED_ENVIRONMENT].is_object());
            fs::remove_dir_all(root).unwrap();
        }
    });
}

#[test]
fn project_preparation_reuses_all_prepared_repository_roots_without_setup() {
    let _lock = crate::test_env::lock();
    let temp = tempfile::tempdir().unwrap();
    let primary = temp.path().join("repo");
    let dependency = temp.path().join("dependency");
    fs::create_dir_all(&primary).unwrap();
    fs::create_dir_all(&dependency).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let prepared = prepare_environment(&json!({
            "environmentId": "prepared-project", "workspacePath": primary,
            "repositories": [
                {"url": "https://example.invalid/repo.git", "path": "repo", "primary": true},
                {"url": "https://example.invalid/dependency.git", "path": "dependency", "primary": false}
            ],
            "setupSteps": [{"command": "false", "workingDirectory": ""}]
        })).await.unwrap();
        assert_eq!(prepared.cwd(), primary.to_str());
        assert_eq!(prepared.runtime_workspace_roots, vec![primary.display().to_string(), dependency.display().to_string()]);
    });
}

#[test]
fn project_preparation_preserves_inherited_sessions_and_validates_paths() {
    let mut request = ExecutionRequest::default();
    let mut payload = json!({"execution":{"environment":{"environmentId":"../escape"}}});
    assert!(configure(&mut request, &payload).is_err());
    payload["workspaceSourceTask"] = json!({"deviceId":"device-1", "taskId":"source"});
    assert!(!configure(&mut request, &payload).unwrap());
    assert!(!request.extra.contains_key(DEFERRED_ENVIRONMENT));
}
