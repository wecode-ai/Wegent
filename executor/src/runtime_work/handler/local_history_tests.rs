use super::*;

#[tokio::test]
async fn cancelling_idle_claude_preserves_its_original_outcome_and_time() {
    let (handler, root) = isolated_runtime_work_handler("claude-idle-stop");
    let mut task = RuntimeTaskLink::new_pending_with_runtime(
        "claude-1".into(),
        "/tmp/project".into(),
        "Task".into(),
        "claude_code",
    );
    task.status = "done".into();
    task.updated_at = 1234;
    task.completed_at = Some(1234);
    handler.upsert_local_task(task);
    let result = handler
        .cancel_task_with_timeout(json!({"taskId":"claude-1"}), Duration::from_millis(20))
        .await
        .unwrap();
    assert_eq!(result["accepted"], true);
    let task = handler.local_task_link("claude-1").unwrap();
    assert_eq!(task.status, "done");
    assert_eq!(task.updated_at, 1234);
    assert_eq!(task.completed_at, Some(1234));
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn missing_local_history_is_explicit_while_liveness_remains_readable() {
    let (handler, root) = isolated_runtime_work_handler("claude-missing-history");
    let mut task = RuntimeTaskLink::new_pending_with_runtime(
        "claude-1".into(),
        "/tmp/project".into(),
        "Task".into(),
        "claude_code",
    );
    task.runtime_handle["userMessagePresentations"] =
        json!([{"content":"original request","clientUserMessageId":"user-1"}]);
    handler.upsert_local_task(task);
    let result = handler
        .transcript(json!({"taskId":"claude-1"}))
        .await
        .unwrap();
    assert_eq!(result["running"], false);
    assert_eq!(result["historyUnavailable"], true);
    assert_eq!(result["messages"], json!([]));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn claude_missing_request_ids_are_assigned_before_recording_messages() {
    let mut first = ExecutionRequest::default();
    ensure_claude_execution_identity("claude-1", &mut first);
    let mut second = ExecutionRequest::default();
    ensure_claude_execution_identity("claude-1", &mut second);
    assert_eq!(first.task_id, "claude-1");
    assert!(!first.subtask_id.is_empty());
    assert_ne!(first.subtask_id, second.subtask_id);
    let id = first.subtask_id.clone();
    ensure_claude_execution_identity("claude-1", &mut first);
    assert_eq!(first.subtask_id, id);
}
