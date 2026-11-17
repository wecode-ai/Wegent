use super::*;

#[test]
fn deferred_worktree_keeps_admitted_revision_after_source_advances() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    super::tests::initialize_repository(&source);
    let manager = WorktreeManager::new(root.path().join("runtime-work/worktrees.json"));
    manager
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(root.path().join("managed").display().to_string()),
            ..Default::default()
        })
        .unwrap();
    let admitted = git_output(&source, &["rev-parse", "HEAD"], None).unwrap();
    let plan = manager.plan(&source, "request-A", None).unwrap();
    fs::write(source.join("tracked.txt"), "advanced\n").unwrap();
    super::tests::run_git(&source, &["commit", "-am", "advance baseline"]);
    fs::write(source.join("tracked.txt"), "private dirty change\n").unwrap();
    fs::write(source.join("untracked.txt"), "private untracked file\n").unwrap();

    let record = manager
        .prepare_planned(
            &source,
            "request-A",
            Some(&plan.base_revision),
            false,
            &plan.path,
            &plan.repo_root_fingerprint,
        )
        .unwrap();

    let worktree = Path::new(&record.path);
    assert_eq!(
        git_output(worktree, &["rev-parse", "HEAD"], None).unwrap(),
        admitted
    );
    assert_eq!(
        fs::read_to_string(worktree.join("tracked.txt")).unwrap(),
        "base\n"
    );
    assert!(!worktree.join("untracked.txt").exists());
    assert_eq!(
        fs::read_to_string(source.join("tracked.txt")).unwrap(),
        "private dirty change\n"
    );
    assert!(source.join("untracked.txt").exists());
}

fn request_fixture() -> (
    tempfile::TempDir,
    WorktreeManager,
    PathBuf,
    RequestWorktreeOwner,
    ManagedWorktree,
) {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    super::tests::initialize_repository(&source);
    let manager = WorktreeManager::new_for_device(
        root.path().join("runtime-work/worktrees.json"),
        "device-A",
    );
    manager
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(root.path().join("managed").display().to_string()),
            ..Default::default()
        })
        .unwrap();
    let owner = RequestWorktreeOwner {
        request_id: "req-A".to_owned(),
        owner_user_id: 6177,
        conversation_id: "assistant-request-req-A".to_owned(),
        device_id: "device-A".to_owned(),
    };
    let plan = manager.plan(&source, &owner.conversation_id, None).unwrap();
    let record = manager
        .prepare_planned_request(
            &source,
            &owner.conversation_id,
            &plan.base_revision,
            &plan.path,
            &plan.repo_root_fingerprint,
            &owner,
        )
        .unwrap();
    (root, manager, source, owner, record)
}

#[test]
fn request_branches_are_owned_idempotent_and_preserved_after_cancellation() {
    let (_root, manager, source, owner, record) = request_fixture();
    let path = Path::new(&record.path);
    assert_eq!(record.branch.as_deref(), Some(owner.branch().as_str()));
    assert_eq!(record.cleanup_policy.as_deref(), Some("preserve"));
    fs::write(path.join("work.txt"), "unfinished evidence\n").unwrap();
    manager.preserve_request_worktree(path, &owner).unwrap();
    assert!(path.join("work.txt").exists());
    let mut archived = RuntimeTaskLink::new_pending(
        owner.conversation_id.clone(),
        record.path.clone(),
        "Request A".to_owned(),
    );
    archived.status = "archived".to_owned();
    assert!(!is_auto_prune_candidate(&record, &[archived]));
    let plan = manager.plan(&source, &owner.conversation_id, None).unwrap();
    let reused = manager
        .prepare_planned_request(
            &source,
            &owner.conversation_id,
            &plan.base_revision,
            &plan.path,
            &plan.repo_root_fingerprint,
            &owner,
        )
        .unwrap();
    assert_eq!(record.base_revision, reused.base_revision);
    assert!(path.join("work.txt").exists());
    let mut intruder = owner.clone();
    intruder.owner_user_id += 1;
    assert!(manager.request_worktree(path, &intruder).is_err());
    assert!(manager
        .prepare_planned_request(
            &source,
            &owner.conversation_id,
            &plan.base_revision,
            &plan.path,
            &plan.repo_root_fingerprint,
            &intruder
        )
        .is_err());
}

#[test]
fn independent_requests_get_distinct_branches_and_worktrees() {
    let (_root, manager, source, owner, record) = request_fixture();
    let mut next = owner.clone();
    next.request_id = "req-B".to_owned();
    next.conversation_id = "assistant-request-req-B".to_owned();
    let plan = manager.plan(&source, &next.conversation_id, None).unwrap();
    let second = manager
        .prepare_planned_request(
            &source,
            &next.conversation_id,
            &plan.base_revision,
            &plan.path,
            &plan.repo_root_fingerprint,
            &next,
        )
        .unwrap();
    assert_ne!(record.path, second.path);
    assert_ne!(record.branch, second.branch);
    assert_eq!(record.base_revision, second.base_revision);
}

#[test]
fn candidate_preserves_dirty_request_and_requires_confirmation_before_publication() {
    let (_root, manager, source, owner, record) = request_fixture();
    let path = Path::new(&record.path);
    let target = resolve_revision_for_test(&source);
    fs::write(path.join("work.txt"), "new request result\n").unwrap();
    let status = git_output(path, &["status", "--porcelain"], None).unwrap();

    let prepared = manager.prepare_request_merge(path, &owner, None).unwrap();
    let evidence = prepared.merge.unwrap();
    assert_eq!(evidence.state, "awaiting_confirmation");
    assert_eq!(resolve_revision_for_test(&source), target);
    assert!(!source.join("work.txt").exists());
    assert_eq!(
        git_output(path, &["status", "--porcelain"], None).unwrap(),
        status
    );
    assert_eq!(
        resolve_revision_for_test(path),
        record.base_revision.unwrap()
    );
    let candidate = evidence.candidate_revision.unwrap();
    assert!(manager
        .publish_request_merge(path, &owner, &target, &candidate, false)
        .is_err());
    let published = manager
        .publish_request_merge(path, &owner, &target, &candidate, true)
        .unwrap();
    assert_eq!(published.merge.unwrap().state, "merged");
    assert_eq!(resolve_revision_for_test(&source), candidate);
    assert_eq!(
        fs::read_to_string(source.join("work.txt")).unwrap(),
        "new request result\n"
    );
    assert!(path.join("work.txt").exists());
    let repeated = manager.prepare_request_merge(path, &owner, None).unwrap();
    let repeated = repeated.merge.unwrap();
    assert_eq!(repeated.state, "merged");
    assert_eq!(
        repeated.candidate_revision.as_deref(),
        Some(candidate.as_str())
    );
    assert_eq!(
        repeated.merged_revision.as_deref(),
        Some(candidate.as_str())
    );
}

#[test]
fn conflict_records_files_without_changing_either_checkout() {
    let (_root, manager, source, owner, record) = request_fixture();
    let path = Path::new(&record.path);
    fs::write(path.join("tracked.txt"), "request version\n").unwrap();
    fs::write(path.join(" leading conflict.txt"), "request addition\n").unwrap();
    fs::write(source.join("tracked.txt"), "base version\n").unwrap();
    fs::write(source.join(" leading conflict.txt"), "target addition\n").unwrap();
    super::tests::run_git(&source, &["add", " leading conflict.txt"]);
    super::tests::run_git(&source, &["commit", "-am", "advance target"]);
    let target = resolve_revision_for_test(&source);
    let evidence = manager
        .prepare_request_merge(path, &owner, None)
        .unwrap()
        .merge
        .unwrap();
    assert_eq!(evidence.state, "conflict");
    assert_eq!(
        evidence.conflict_files,
        vec![" leading conflict.txt", "tracked.txt"]
    );
    assert!(evidence.candidate_revision.is_none());
    assert_eq!(resolve_revision_for_test(&source), target);
    assert_eq!(
        fs::read_to_string(source.join("tracked.txt")).unwrap(),
        "base version\n"
    );
    assert_eq!(
        fs::read_to_string(path.join("tracked.txt")).unwrap(),
        "request version\n"
    );
    manager.request_worktree(path, &owner).unwrap();
}

#[test]
fn clean_divergent_candidate_merges_both_sides_and_rejects_a_moved_baseline() {
    let (_root, manager, source, owner, record) = request_fixture();
    let path = Path::new(&record.path);
    fs::write(path.join("request.txt"), "request work\n").unwrap();
    fs::write(source.join("base.txt"), "target work\n").unwrap();
    super::tests::run_git(&source, &["add", "base.txt"]);
    super::tests::run_git(&source, &["commit", "-m", "advance target"]);
    let target = resolve_revision_for_test(&source);
    let evidence = manager
        .prepare_request_merge(path, &owner, None)
        .unwrap()
        .merge
        .unwrap();
    assert_eq!(evidence.state, "awaiting_confirmation");
    let candidate = evidence.candidate_revision.unwrap();
    assert_eq!(
        git_output(path, &["show", &format!("{candidate}:base.txt")], None).unwrap(),
        "target work"
    );
    assert_eq!(
        git_output(path, &["show", &format!("{candidate}:request.txt")], None).unwrap(),
        "request work"
    );
    fs::write(source.join("base.txt"), "moved again\n").unwrap();
    super::tests::run_git(&source, &["commit", "-am", "move target again"]);
    let moved = resolve_revision_for_test(&source);
    assert!(manager
        .publish_request_merge(path, &owner, &target, &candidate, true)
        .unwrap_err()
        .starts_with("worktree_merge_target_changed:"));
    assert_eq!(resolve_revision_for_test(&source), moved);
    assert!(!source.join("request.txt").exists());
}

fn resolve_revision_for_test(path: &Path) -> String {
    git_output(path, &["rev-parse", "HEAD"], None).unwrap()
}

#[test]
fn atomic_guard_rejects_an_advanced_ancestor_of_the_candidate() {
    let (_root, manager, source, owner, record) = request_fixture();
    let path = Path::new(&record.path);
    fs::write(path.join("request.txt"), "request work\n").unwrap();
    let evidence = manager
        .prepare_request_merge(path, &owner, None)
        .unwrap()
        .merge
        .unwrap();
    let candidate = evidence.candidate_revision.as_deref().unwrap();
    super::tests::run_git(&source, &["merge", "--ff-only", &evidence.request_revision]);
    assert!(git_output(
        &source,
        &["merge-base", "--is-ancestor", "HEAD", candidate],
        None
    )
    .is_ok());
    let error =
        requests::publish::guarded_fast_forward(&source, &manager.state_path, &evidence, candidate)
            .unwrap_err();
    assert!(error.contains("worktree_merge_target_changed:"), "{error}");
    assert_eq!(
        resolve_revision_for_test(&source),
        evidence.request_revision
    );
    assert!(path.join("request.txt").exists());
}

#[test]
fn publication_honors_existing_hooks_and_retains_failure_evidence() {
    let (_root, manager, source, owner, record) = request_fixture();
    let path = Path::new(&record.path);
    fs::write(path.join("request.txt"), "request work\n").unwrap();
    let evidence = manager
        .prepare_request_merge(path, &owner, None)
        .unwrap()
        .merge
        .unwrap();
    let hooks = source.join(".git/hooks");
    let target_ref = git_output(&source, &["symbolic-ref", "HEAD"], None).unwrap();
    eprintln!("Owner rejection fixture target ref: {target_ref}");
    let quoted_target = target_ref.replace('\'', "'\\''");
    install_test_hook(&hooks.join("reference-transaction"), &format!("#!/bin/sh\nif [ \"$1\" = prepared ]; then\n  while read -r old new reference; do\n    if [ \"$reference\" = '{quoted_target}' ]; then\n      printf '%s\\n' \"$reference\" > .git/request-rejection-hook-input\n      printf '%s\\n' \"rejected-by-owner: $reference\" >&2\n      exit 1\n    fi\n  done\nfi\n"));
    let outcome = manager
        .publish_request_merge(
            path,
            &owner,
            &evidence.target_revision,
            evidence.candidate_revision.as_deref().unwrap(),
            true,
        )
        .unwrap();
    let outcome = outcome.merge.unwrap();
    assert_eq!(
        fs::read_to_string(source.join(".git/request-rejection-hook-input"))
            .unwrap()
            .trim(),
        target_ref
    );
    assert_eq!(outcome.state, "escalated");
    assert_eq!(outcome.reason_code.as_deref(), Some("publish_failed"));
    assert_eq!(
        outcome.observed_target_revision.as_deref(),
        Some(evidence.target_revision.as_str())
    );
    assert!(outcome.target_worktree_dirty.is_some());
    assert_eq!(resolve_revision_for_test(&source), evidence.target_revision);
    assert!(path.join("request.txt").exists());
    assert_eq!(outcome.candidate_revision, evidence.candidate_revision);
    let refreshed = manager.prepare_request_merge(path, &owner, None).unwrap();
    assert_eq!(refreshed.merge.unwrap().state, "awaiting_confirmation");
}

#[test]
fn publication_forwards_post_merge_and_recovers_after_registry_write_interruption() {
    let (_root, manager, source, owner, record) = request_fixture();
    let path = Path::new(&record.path);
    fs::write(path.join("request.txt"), "request work\n").unwrap();
    let evidence = manager
        .prepare_request_merge(path, &owner, None)
        .unwrap()
        .merge
        .unwrap();
    let candidate = evidence.candidate_revision.as_deref().unwrap();
    install_test_hook(
        &source.join(".git/hooks/post-merge"),
        "#!/bin/sh\nprintf '%s\\n' forwarded > .git/request-post-merge-proof\n",
    );
    requests::publish::guarded_fast_forward(&source, &manager.state_path, &evidence, candidate)
        .unwrap();
    assert_eq!(
        fs::read_to_string(source.join(".git/request-post-merge-proof")).unwrap(),
        "forwarded\n"
    );
    // Git succeeded but the durable record still awaits confirmation, as after a crash.
    let recovered = manager
        .publish_request_merge(path, &owner, &evidence.target_revision, candidate, true)
        .unwrap();
    assert_eq!(
        recovered.merge.unwrap().merged_revision.as_deref(),
        Some(candidate)
    );
    assert_eq!(
        manager
            .publish_request_merge(path, &owner, &evidence.target_revision, candidate, true)
            .unwrap()
            .merge
            .unwrap()
            .state,
        "merged"
    );
}

fn install_test_hook(path: &Path, content: &str) {
    fs::write(path, content).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
}
