use super::*;

#[tokio::test]
async fn queued_request_keeps_immutable_base_and_ownership_through_restart() {
    let (mut handler, root) = isolated_runtime_work_handler("queued-request-base");
    let source = root.join("source");
    initialize_test_repository(&source);
    run_test_git(&source, &["config", "core.autocrlf", "false"]);
    handler.worktrees =
        WorktreeManager::new_for_device(root.join("runtime-work/worktrees.json"), "device-1");
    handler
        .worktrees
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(root.join("managed").display().to_string()),
            ..Default::default()
        })
        .unwrap();
    {
        let mut scheduler = handler.turn_scheduler.lock().unwrap();
        scheduler.settings = RuntimeSettings::uniform(1);
        scheduler
            .active_task_ids
            .insert("occupied".to_owned(), RuntimeTaskKind::Personal);
    }
    let owner = json!({"requestId":"req-A","ownerUserId":6177,"conversationId":"assistant-request-req-A","deviceId":"device-1"});
    let origin = json!({"assistantRequest":owner});
    let admitted = git_revision(&source);
    let response = handler.create_task(json!({
        "taskId":"assistant-request-req-A","runtime":"codex","ephemeral":true,
        "workspacePath":source,"execution":{"workspace":{"source":"git_worktree"}},
        "origin":origin,
        "executionRequest":{"task_id":"assistant-request-req-A","subtask_id":"req-A-initial","prompt":"Independent request","project_workspace_path":source,"workspace_source":"git_worktree","origin":origin}
    })).await.unwrap();
    assert_eq!(response["status"], "queued");
    let mut restored = read_runtime_turn_queue(&root.join("runtime-work/turn-queue.json")).unwrap();
    assert_eq!(
        super::super::turns::remove_worktree_turns_after_restart(&handler.worktrees, &mut restored),
        0
    );
    let mut turn = restored.pop_front().unwrap();
    assert_eq!(turn.request.extra["deferred_worktree_ref"], admitted);
    assert_eq!(turn.request.extra["origin"]["assistantRequest"], owner);
    fs::write(source.join("tracked.txt"), "advanced\n").unwrap();
    run_test_git(&source, &["commit", "-am", "advance target"]);
    fs::write(source.join("tracked.txt"), "private dirty change\n").unwrap();
    fs::write(source.join("untracked.txt"), "private untracked file\n").unwrap();
    handler.prepare_deferred_worktree(&mut turn).await.unwrap();
    let path = Path::new(turn.request.cwd().unwrap());
    assert_eq!(git_revision(path), admitted);
    assert_eq!(
        fs::read_to_string(path.join("tracked.txt")).unwrap(),
        "base\n"
    );
    assert!(!path.join("untracked.txt").exists());
    let owner = serde_json::from_value(owner).unwrap();
    let record = handler.worktrees.request_worktree(path, &owner).unwrap();
    assert_eq!(record.base_revision.as_deref(), Some(admitted.as_str()));
    assert_eq!(record.cleanup_policy.as_deref(), Some("preserve"));
    assert_eq!(
        fs::read_to_string(source.join("tracked.txt")).unwrap(),
        "private dirty change\n"
    );
    fs::remove_dir_all(root).unwrap();
}

fn git_revision(path: &Path) -> String {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "HEAD"])
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}
