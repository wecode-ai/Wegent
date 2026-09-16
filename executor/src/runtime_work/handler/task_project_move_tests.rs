use super::*;
use crate::runtime_work::response::workspace_response;

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
        assert_eq!(projected[0].group_project_key.as_deref(), Some("/target"));
        assert_eq!(projected[0].workspace_path, path);
        assert_eq!(projected[0].thread_id.as_deref(), Some("thread-1"));
        assert!(projected[0].running);
        let response = workspace_response(projected, vec![]);
        assert_eq!(response[0]["workspacePath"], "/target");
        assert_eq!(response[0]["tasks"][0]["workspacePath"], path);
        assert_eq!(response[0]["tasks"][0]["taskId"], "task-1");
    }
}
