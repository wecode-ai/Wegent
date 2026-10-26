use super::*;

fn request() -> ExecutionRequest {
    ExecutionRequest {
        task_id: "42".into(),
        subtask_id: "7".into(),
        ..Default::default()
    }
}

fn query(token: &str, root: &Path) -> ArtifactQuery {
    ArtifactQuery {
        binding_id: format!("{:x}", Sha256::digest(token.as_bytes())),
        task_id: "42".into(),
        subtask_id: "7".into(),
        root_path: Some(root.canonicalize().unwrap().to_string_lossy().into_owned()),
        path: Some("report.txt".into()),
        offset: Some(0),
    }
}

#[test]
fn device_reads_use_durable_native_workspace_and_reject_forged_existing_roots() {
    let home = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let native = files.path().join("custom-worktree");
    let unrelated = files.path().join("another-task");
    fs::create_dir_all(&native).unwrap();
    fs::create_dir_all(&unrelated).unwrap();
    fs::write(native.join("report.txt"), "original").unwrap();
    fs::write(unrelated.join("report.txt"), "private").unwrap();
    bind_at(home.path(), &request(), "token-a", &native).unwrap();
    let mut read = query("token-a", &native);
    let response = execute_at(home.path(), &read).unwrap();
    assert_eq!(response["content_base64"], "b3JpZ2luYWw=");
    read.root_path = Some(unrelated.canonicalize().unwrap().display().to_string());
    assert!(execute_at(home.path(), &read)
        .unwrap_err()
        .contains("binding"));
    read.path = None;
    assert!(execute_at(home.path(), &read).is_err());
    read.root_path = None;
    assert_eq!(
        execute_at(home.path(), &read).unwrap()["workspace_root"],
        native.canonicalize().unwrap().display().to_string()
    );
}

#[test]
fn old_source_remains_bound_after_new_execution_and_cannot_be_rebound() {
    let home = tempfile::tempdir().unwrap();
    let original = tempfile::tempdir().unwrap();
    let rebound = tempfile::tempdir().unwrap();
    fs::write(original.path().join("report.txt"), "original").unwrap();
    fs::write(rebound.path().join("report.txt"), "new source").unwrap();
    bind_at(home.path(), &request(), "token-a", original.path()).unwrap();
    bind_at(home.path(), &request(), "token-a", original.path()).unwrap();
    assert!(bind_at(home.path(), &request(), "token-a", rebound.path()).is_err());
    bind_at(home.path(), &request(), "token-b", rebound.path()).unwrap();
    assert_eq!(
        execute_at(home.path(), &query("token-a", original.path())).unwrap()["content_base64"],
        "b3JpZ2luYWw="
    );
    assert_ne!(
        query("token-a", original.path()).binding_id,
        query("token-b", rebound.path()).binding_id
    );
}

#[test]
fn identity_mismatch_missing_bindings_and_deleted_files_never_fall_back() {
    let home = tempfile::tempdir().unwrap();
    let native = tempfile::tempdir().unwrap();
    fs::write(native.path().join("report.txt"), "original").unwrap();
    bind_at(home.path(), &request(), "token-a", native.path()).unwrap();
    let mut read = query("token-a", native.path());
    read.task_id = "43".into();
    assert!(execute_at(home.path(), &read).is_err());
    read.task_id = "42".into();
    read.subtask_id = "8".into();
    assert!(execute_at(home.path(), &read).is_err());
    assert!(execute_at(home.path(), &query("other-token", native.path())).is_err());
    fs::remove_file(native.path().join("report.txt")).unwrap();
    assert!(execute_at(home.path(), &query("token-a", native.path())).is_err());
}

#[cfg(unix)]
#[test]
fn symlinked_workspace_and_file_cannot_escape_original_binding() {
    let home = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let native = files.path().join("native");
    let outside = files.path().join("outside");
    fs::create_dir_all(&native).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "private").unwrap();
    bind_at(home.path(), &request(), "token-a", &native).unwrap();
    let read = query("token-a", &native);
    std::os::unix::fs::symlink(outside.join("secret.txt"), native.join("report.txt")).unwrap();
    assert!(execute_at(home.path(), &read)
        .unwrap_err()
        .contains("outside workspace"));
    fs::remove_file(native.join("report.txt")).unwrap();
    fs::remove_dir(&native).unwrap();
    std::os::unix::fs::symlink(&outside, &native).unwrap();
    assert!(execute_at(home.path(), &read).is_err());
}

#[test]
fn only_matching_linked_task_tokens_capture_native_workspace() {
    let mut request = request();
    let payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({"type":"task_token","task_id":42,"subtask_id":7})).unwrap(),
    );
    let token = format!("header.{payload}.signature");
    request.auth_token = Some(token.clone());
    assert_eq!(linked_token(&request), Some(token.as_str()));
    request.subtask_id = "8".into();
    assert!(linked_token(&request).is_none());
    request.auth_token = Some("opaque-account-token".into());
    assert!(linked_token(&request).is_none());
}

#[test]
fn real_custom_git_worktrees_are_valid_native_artifact_roots() {
    let home = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let repository = files.path().join("repo");
    let worktree = files.path().join("custom-worktree");
    fs::create_dir(&repository).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(&repository)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "--quiet"]);
    fs::write(repository.join("report.txt"), "original").unwrap();
    git(&["add", "report.txt"]);
    git(&[
        "-c",
        "user.name=Artifact Test",
        "-c",
        "user.email=artifact@invalid",
        "commit",
        "--quiet",
        "-m",
        "seed",
    ]);
    git(&[
        "worktree",
        "add",
        "--quiet",
        "--detach",
        worktree.to_str().unwrap(),
        "HEAD",
    ]);
    bind_at(home.path(), &request(), "worktree-token", &worktree).unwrap();
    assert_eq!(
        execute_at(home.path(), &query("worktree-token", &worktree)).unwrap()["content_base64"],
        "b3JpZ2luYWw="
    );
}

#[test]
fn device_command_preserves_response_contract_and_rejects_forged_roots() {
    let home = tempfile::tempdir().unwrap();
    let native = tempfile::tempdir().unwrap();
    let unrelated = tempfile::tempdir().unwrap();
    fs::write(native.path().join("report.txt"), "original").unwrap();
    fs::write(unrelated.path().join("report.txt"), "private").unwrap();
    bind_at(home.path(), &request(), "token-a", native.path()).unwrap();
    let mut read = query("token-a", native.path());
    let payload = |query: &ArtifactQuery| json!({"args":[serde_json::to_string(query).unwrap()]});
    let response = serde_json::to_value(command_at(home.path(), &payload(&read))).unwrap();
    assert_eq!(response["success"], true);
    assert_eq!(response["stdout"]["content_base64"], "b3JpZ2luYWw=");
    assert_eq!(response["duration"], 0.0);
    read.root_path = Some(
        unrelated
            .path()
            .canonicalize()
            .unwrap()
            .display()
            .to_string(),
    );
    let rejected = command_at(home.path(), &payload(&read));
    assert!(!rejected.success);
    assert!(rejected.error.unwrap().contains("binding"));
    assert_eq!(rejected.stdout, "");
}
