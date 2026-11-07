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
fn get_task_preserves_only_authoritative_native_turn_identity() {
    use crate::runtime_work::lifecycle::{
        begin_native_request, native_execution_state, NativeExecutionPhase,
    };
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("executor");
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", home.to_str().unwrap());
    for phase in [NativeExecutionPhase::Running, NativeExecutionPhase::Idle] {
        let mut link = task(root.path(), Some("local_path"));
        begin_native_request(&mut link);
        let mut state = native_execution_state(&link).unwrap();
        state.phase = phase;
        state.latest_turn_id = Some("authoritative-native-turn".into());
        state.turn_id = (phase == NativeExecutionPhase::Running).then(|| "active-turn".into());
        state.execution_outcome = Some("completed".into());
        link.execution_state = Some(state);
        link.runtime_handle["lastTurnId"] = json!("forged-stored-turn");
        link.runtime_handle["messages"] = json!([{"content":"private-transcript"}]);
        let path = root.path().join(format!("{phase:?}.json"));
        let mut handler = RuntimeWorkRpcHandler::new("device", "codex");
        handler.store = RuntimeWorkStore::new(path.clone());
        handler.store.upsert_task(link.clone());
        let read = handler
            .get_task(&json!({"taskId":link.local_task_id}))
            .unwrap();
        assert_eq!(
            read["task"]["runtimeHandle"]["lastTurnId"],
            "authoritative-native-turn"
        );
        assert_eq!(
            read["task"]["runtimeHandle"]["threadId"],
            "native-primary-thread"
        );
        for private in [
            "executionRequest",
            "private-task-token",
            "private-runtime-token",
            "private-account",
            "private-transcript",
            "forged-stored-turn",
            "forged-stored-thread",
        ] {
            assert!(
                !serde_json::to_string(&read).unwrap().contains(private),
                "{private}"
            );
        }
        // A cold index has no current-process native lifecycle authority.
        handler.store = RuntimeWorkStore::new(path);
        let cold = handler
            .get_task(&json!({"taskId":link.local_task_id}))
            .unwrap();
        assert!(cold["task"]["runtimeHandle"].get("lastTurnId").is_none());
        for stale in [false, true] {
            if stale {
                link.execution_state.as_mut().unwrap().epoch = "another-process-epoch".into();
            } else {
                link.execution_state = None;
            }
            handler.store.upsert_task(link.clone());
            let read = handler
                .get_task(&json!({"taskId":link.local_task_id}))
                .unwrap();
            assert!(read["task"]["runtimeHandle"].get("lastTurnId").is_none());
            if !stale {
                begin_native_request(&mut link);
                link.execution_state.as_mut().unwrap().latest_turn_id =
                    Some("wrong-epoch-turn".into());
            }
        }
    }
}

fn recorded_stand_in_task(path: &Path, origin_type: &str) -> RuntimeTaskLink {
    let mut link = task(path, None);
    link.runtime_project_key = Some("recorded-project".into());
    link.runtime_workspace_roots = vec![path.to_string_lossy().into_owned(), "/other-root".into()];
    let origin = json!({"type":origin_type,"userId":7,"deviceId":"original-device"});
    let request: ExecutionRequest = serde_json::from_value(json!({
        "workspace_source":null,"project_workspace_path":path,
        "runtime_project_key":link.runtime_project_key,
        "runtime_workspace_roots":link.runtime_workspace_roots,
        "origin":origin,"user_id":7,"auth_token":"private-old-token"
    }))
    .unwrap();
    link.runtime_handle["origin"] = origin;
    store_runtime_execution_request(&mut link.runtime_handle, &request);
    link.status = "done".into();
    link.completed_at = Some(now_ms());
    link
}

fn cold_task_views(link: RuntimeTaskLink, path: &Path) -> (Value, Value) {
    let task_id = link.local_task_id.clone();
    RuntimeWorkStore::new(path.to_path_buf()).upsert_task(link);
    let before = fs::read(path).unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("device", "codex");
    handler.store = RuntimeWorkStore::new(path.to_path_buf());
    let summary = handler.store.get_task_summary(&task_id).unwrap();
    let rows = crate::runtime_work::response::workspace_response(vec![summary], vec![]);
    let read = handler.get_task(&json!({"taskId":task_id})).unwrap();
    assert_eq!(
        fs::read(path).unwrap(),
        before,
        "Reading historical intent must not migrate the index"
    );
    (read["task"].clone(), rows[0]["tasks"][0].clone())
}

#[test]
fn recorded_stand_in_workspace_binding_survives_cold_get_and_list() {
    let _lock = crate::test_env::lock();
    let (root, _worktree, cwd) = linked_workspace();
    let home = root.path().join("executor");
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", home.to_str().unwrap());
    for origin in ["stand_in_identity", "stand_in_task"] {
        for missing_source in [false, true] {
            let mut link = recorded_stand_in_task(&cwd, origin);
            if missing_source {
                link.runtime_handle["executionRequest"]
                    .as_object_mut()
                    .unwrap()
                    .remove("workspace_source");
            }
            let (read, listed) = cold_task_views(
                link,
                &root.path().join(format!("{origin}-{missing_source}.json")),
            );
            for value in [&read, &listed] {
                assert_eq!(value["workspacePath"], cwd.to_string_lossy().as_ref());
                assert_eq!(value["workspaceKind"], "workspace");
                assert!(value.get("worktreeId").is_none());
                assert!(!serde_json::to_string(value)
                    .unwrap()
                    .contains("private-old-token"));
            }
            assert!(read["runtimeHandle"].get("executionRequest").is_none());
        }
    }
}

#[test]
fn recorded_stand_in_workspace_binding_rejects_ambiguous_or_managed_intent() {
    let _lock = crate::test_env::lock();
    let (root, worktree, cwd) = linked_workspace();
    let home = root.path().join("executor");
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", home.to_str().unwrap());
    for case in [
        "managed",
        "unknown",
        "invalid",
        "no-key",
        "key-conflict",
        "root-conflict",
        "cwd-conflict",
        "origin-conflict",
        "ordinary",
        "deferred",
        "no-roots",
        "empty-root",
        "unselected-cwd",
        "no-origin",
    ] {
        let mut link = recorded_stand_in_task(&cwd, "stand_in_task");
        let request = &mut link.runtime_handle["executionRequest"];
        match case {
            "managed" => request["workspace_source"] = json!("git_worktree"),
            "unknown" => request["workspace_source"] = json!("unknown-mode"),
            "invalid" => request["workspace_source"] = json!(false),
            "no-key" => link.runtime_project_key = None,
            "key-conflict" => request["runtime_project_key"] = json!("other-project"),
            "root-conflict" => request["runtime_workspace_roots"] = json!(["/other-root"]),
            "cwd-conflict" => request["project_workspace_path"] = json!("/other-root"),
            "origin-conflict" => request["origin"]["userId"] = json!(8),
            "ordinary" => {
                request["origin"]["type"] = json!("ordinary");
                link.runtime_handle["origin"]["type"] = json!("ordinary");
            }
            "deferred" => request["deferred_project_environment"] = json!({"repositories":[]}),
            "no-roots" => {
                request
                    .as_object_mut()
                    .unwrap()
                    .remove("runtime_workspace_roots");
            }
            "empty-root" => {
                request["runtime_workspace_roots"] = json!([""]);
                link.runtime_workspace_roots = vec![String::new()];
            }
            "unselected-cwd" => {
                request["runtime_workspace_roots"] = json!(["/other-root"]);
                link.runtime_workspace_roots = vec!["/other-root".into()];
            }
            "no-origin" => {
                request.as_object_mut().unwrap().remove("origin");
            }
            _ => unreachable!(),
        }
        let (read, listed) = cold_task_views(link, &root.path().join(format!("{case}.json")));
        assert_eq!(read["workspaceKind"], "worktree", "{case}");
        assert_eq!(listed["workspaceKind"], "worktree", "{case}");
        assert_eq!(
            listed["workspacePath"],
            worktree.to_string_lossy().as_ref(),
            "{case}"
        );
    }
    let mut empty = recorded_stand_in_task(&cwd, "stand_in_task");
    empty.workspace_path.clear();
    empty.runtime_workspace_roots = vec![String::new()];
    empty.runtime_handle["executionRequest"]["project_workspace_path"] = json!("");
    empty.runtime_handle["executionRequest"]["runtime_workspace_roots"] = json!([""]);
    assert_eq!(empty.execution_workspace_path("/assigned"), "/assigned");
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
