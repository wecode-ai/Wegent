use super::*;

fn git(root: &Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .expect("execute fixture Git");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn linked_workspace() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let repository = root.path().join("repository");
    fs::create_dir_all(&repository).unwrap();
    git(&repository, &["init", "--quiet"]);
    git(
        &repository,
        &[
            "-c",
            "user.name=QA",
            "-c",
            "user.email=qa@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            "baseline",
        ],
    );
    let worktree = root.path().join("linked");
    git(
        &repository,
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "qa-fixture",
            worktree.to_str().unwrap(),
        ],
    );
    let cwd = worktree.join("fixtures");
    fs::create_dir_all(&cwd).unwrap();
    (root, worktree, cwd)
}

fn task(path: &Path, source: Option<&str>) -> RuntimeTaskLink {
    let mut link = RuntimeTaskLink::new_pending(
        "stand-in-chat-0-primary".into(),
        path.to_string_lossy().into_owned(),
        "Primary".into(),
    );
    link.thread_id = Some("native-primary-thread".into());
    link.runtime_handle["threadId"] = json!("forged-stored-thread");
    if let Some(source) = source {
        link.runtime_handle["executionRequest"] = json!({
            "workspace_source":source, "auth_token":"private-task-token",
            "runtime_auth_token":"private-runtime-token", "user_name":"private-account",
        });
    }
    link
}

#[test]
fn explicit_local_path_get_preserves_unlisted_primary_cwd_without_private_metadata() {
    let _lock = crate::test_env::lock();
    let (root, _worktree, cwd) = linked_workspace();
    let home = root.path().join("executor");
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", home.to_str().unwrap());
    let handler = RuntimeWorkRpcHandler::new("device", "codex");
    handler.store.upsert_task(task(&cwd, Some("local_path")));

    let result = handler
        .get_task(&json!({"taskId":"stand-in-chat-0-primary"}))
        .unwrap();

    assert_eq!(
        result["task"]["workspacePath"],
        cwd.to_string_lossy().as_ref()
    );
    assert_eq!(result["task"]["workspaceKind"], "workspace");
    assert!(result["task"].get("worktreeId").is_none());
    let handle = result["task"]["runtimeHandle"].as_object().unwrap();
    assert!(handle.keys().all(|key| matches!(
        key.as_str(),
        "runtime"
            | "wegentTeam"
            | "modelSelection"
            | "model_selection"
            | "queuePosition"
            | "threadId"
    )));
    assert_eq!(handle["threadId"], "native-primary-thread");
    let encoded = serde_json::to_string(&result).unwrap();
    for private in [
        "executionRequest",
        "private-task-token",
        "private-runtime-token",
        "private-account",
        "forged-stored-thread",
    ] {
        assert!(!encoded.contains(private));
    }
}

#[test]
fn explicit_local_path_list_preserves_worktree_root_and_nested_task_cwd() {
    let (_root, worktree, cwd) = linked_workspace();
    for path in [&worktree, &cwd] {
        let link = task(path, Some("local_path"));
        let rows =
            crate::runtime_work::response::workspace_response(vec![link.list_summary()], vec![]);
        assert_eq!(
            rows[0]["tasks"][0]["workspacePath"],
            path.to_string_lossy().as_ref()
        );
        assert_eq!(rows[0]["tasks"][0]["workspaceKind"], "workspace");
        assert!(rows[0]["tasks"][0].get("worktreeId").is_none());
    }
}

#[test]
fn managed_and_legacy_worktree_tasks_keep_the_original_root_boundary() {
    let (_root, worktree, cwd) = linked_workspace();
    for source in [Some("git_worktree"), None] {
        let link = task(&cwd, source);
        let rows = crate::runtime_work::response::workspace_response(vec![link], vec![]);
        assert_eq!(
            rows[0]["tasks"][0]["workspacePath"],
            worktree.to_string_lossy().as_ref()
        );
        assert_eq!(rows[0]["tasks"][0]["workspaceKind"], "worktree");
        assert!(rows[0]["tasks"][0]["worktreeId"].is_string());
    }
}

#[test]
fn explicit_local_path_does_not_reclassify_standalone_chat() {
    let link = task(Path::new("/workspace/Codex/chat-task"), Some("local_path"));
    let value = crate::runtime_work::response::local_task_json(link);
    assert_eq!(value["workspaceKind"], "chat");
    assert!(value.get("worktreeId").is_none());
}

#[test]
fn stand_in_current_workspace_intent_survives_completion_and_cold_summary() {
    let _lock = crate::test_env::lock();
    let (root, _worktree, cwd) = linked_workspace();
    let home = root.path().join("executor");
    let codex_home = root.path().join("codex");
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", home.to_str().unwrap());
    let _codex_home = ScalarEnv::set("CODEX_HOME", codex_home.to_str().unwrap());
    let project = crate::runtime_work::codex_global_state::upsert_codex_global_local_project(
        "dots",
        "Dots",
        &[cwd.to_string_lossy().into_owned()],
        None,
        None,
    )
    .unwrap();
    let config = json!({"workspace":{
        "projectKey":project.key, "workspacePath":cwd, "executionMode":"current_workspace"
    }});
    let mut payload = json!({"executionRequest":ExecutionRequest::default()});
    super::super::stand_in_workspace::apply_stand_in_workspace(&mut payload, &config).unwrap();
    assert_eq!(payload["execution"]["workspace"]["source"], "local_path");
    let request = execution_request(&payload).unwrap();
    assert_eq!(request.workspace_source.as_deref(), Some("local_path"));
    let mut link = task(&cwd, None);
    store_runtime_execution_request(&mut link.runtime_handle, &request);
    link.status = "done".into();
    link.completed_at = Some(now_ms());
    let path = root.path().join("runtime.json");
    RuntimeWorkStore::new(path.clone()).upsert_task(link);

    let mut handler = RuntimeWorkRpcHandler::new("device", "codex");
    handler.store = RuntimeWorkStore::new(path);
    let summary = handler
        .store
        .get_task_summary("stand-in-chat-0-primary")
        .unwrap();
    let rows = crate::runtime_work::response::workspace_response(vec![summary], vec![]);
    let read = handler
        .get_task(&json!({"taskId":"stand-in-chat-0-primary"}))
        .unwrap();
    for result in [&rows[0]["tasks"][0], &read["task"]] {
        assert_eq!(result["workspacePath"], cwd.to_string_lossy().as_ref());
        assert_eq!(result["workspaceKind"], "workspace");
        assert!(result.get("worktreeId").is_none());
    }
    assert!(read["task"]["runtimeHandle"]
        .get("executionRequest")
        .is_none());
}
