use super::*;
use crate::runtime_work::response::workspace_response;

#[tokio::test]
async fn restored_tasks_keep_their_directory_when_assigned_to_an_ancestor_project() {
    let _guard = crate::test_env::lock();
    let project = tempfile::tempdir().unwrap();
    let executor_home = project.path().join("executor-home");
    let restored = executor_home.join("restored-workspaces/task-1");
    std::fs::create_dir_all(&restored).unwrap();
    let project_path = normalize_workspace_path(&project.path().to_string_lossy());
    let restored_path = normalize_workspace_path(&restored.to_string_lossy());
    let previous = std::env::var_os("WEGENT_EXECUTOR_HOME");
    std::env::set_var("WEGENT_EXECUTOR_HOME", &executor_home);
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let payload = json!({
        "electron-saved-workspace-roots": [project_path],
        "thread-project-assignments": {"thread-1": {"projectId": project_path}}
    });
    let index = CodexGlobalProjectIndex::from_test_payload(payload.as_object().unwrap());
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        restored_path.clone(),
        "Restored task".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());

    let projected = handler.visible_links_for_projects(vec![link], &index);
    let response = workspace_response(projected, vec![]);

    match previous {
        Some(value) => std::env::set_var("WEGENT_EXECUTOR_HOME", value),
        None => std::env::remove_var("WEGENT_EXECUTOR_HOME"),
    }
    assert_eq!(response[0]["workspacePath"], project_path);
    assert_eq!(response[0]["tasks"][0]["workspacePath"], restored_path);
}

#[tokio::test]
async fn project_moves_preserve_nested_execution_roots_without_changing_normal_grouping() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    for (source, cwd, target, expected) in [
        ("/source", "/source/frontend", "/source", "/source"),
        (
            "/source/frontend",
            "/source/frontend",
            "/source",
            "/source/frontend",
        ),
        ("/source", "/source", "/source/frontend", "/source"),
    ] {
        let payload = json!({
            "electron-saved-workspace-roots": ["/source", "/source/frontend"],
            "thread-project-assignments": {"thread-1": {"projectId": target}}
        });
        let index = CodexGlobalProjectIndex::from_test_payload(payload.as_object().unwrap());
        let mut link =
            RuntimeTaskLink::new_pending("task-1".to_owned(), cwd.to_owned(), "Task".to_owned());
        link.thread_id = Some("thread-1".to_owned());
        link.runtime_project_key = Some(source.to_owned());
        let links = handler.visible_links_for_projects(vec![link], &index);
        let response = workspace_response(links, vec![]);
        assert_eq!(
            response[0]["workspacePath"],
            normalize_workspace_path(target)
        );
        assert_eq!(
            response[0]["tasks"][0]["workspacePath"],
            normalize_workspace_path(expected)
        );
    }
}

#[tokio::test]
async fn projectless_tasks_do_not_reappear_under_a_stale_assignment() {
    let payload = json!({
        "electron-saved-workspace-roots": ["/source", "/target"],
        "thread-project-assignments": {"thread-1": {"projectId": "/target"}},
        "projectless-thread-ids": ["thread-1"]
    });
    let index = CodexGlobalProjectIndex::from_test_payload(payload.as_object().unwrap());
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let mut link =
        RuntimeTaskLink::new_pending("task-1".to_owned(), "/source".to_owned(), "Task".to_owned());
    link.thread_id = Some("thread-1".to_owned());

    assert!(handler
        .visible_links_for_projects(vec![link], &index)
        .is_empty());
}

#[tokio::test]
async fn moved_tasks_keep_execution_identity_and_override_creation_project() {
    let payload = json!({
        "electron-saved-workspace-roots": ["/source", "/target"],
        "thread-project-assignments": {"thread-1": {"projectId": "/target"}}
    });
    let index = CodexGlobalProjectIndex::from_test_payload(payload.as_object().unwrap());
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

    for (runtime, path) in [
        ("codex", "/source"),
        ("codex", "/tmp/Codex/chat"),
        ("claudecode", "/source"),
    ] {
        let mut link = RuntimeTaskLink::new_pending_with_runtime(
            "task-1".to_owned(),
            path.to_owned(),
            "Original title".to_owned(),
            runtime.to_owned(),
        );
        link.thread_id = Some("thread-1".to_owned());
        link.runtime_project_key = Some("/source".to_owned());
        link.running = true;
        let projected = handler.visible_links_for_projects(vec![link], &index);
        assert_eq!(projected.len(), 1);
        assert_eq!(
            projected[0].group_project_key.as_deref(),
            Some(normalize_workspace_path("/target").as_str())
        );
        assert_eq!(projected[0].workspace_path, path);
        assert_eq!(projected[0].thread_id.as_deref(), Some("thread-1"));
        assert!(projected[0].running);
        let response = workspace_response(projected, vec![]);
        assert_eq!(
            response[0]["workspacePath"],
            normalize_workspace_path("/target")
        );
        assert_eq!(
            response[0]["tasks"][0]["workspacePath"],
            normalize_workspace_path(path)
        );
        assert_eq!(response[0]["tasks"][0]["taskId"], "task-1");
    }
}
