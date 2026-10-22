use super::*;

#[tokio::test]
async fn transcript_transport_is_opt_in_and_keeps_legacy_responses() {
    use base64::Engine;
    let (handler, root) = isolated_runtime_work_handler("transcript-protocol");
    fs::create_dir_all(&root).unwrap();
    let legacy = handler
        .transcript(json!({"taskId":"pending-task"}))
        .await
        .unwrap();
    assert!(legacy["messages"].is_array());
    assert!(legacy.get("transcriptProtocolVersion").is_none());
    let modern = handler
        .transcript(json!({"taskId":"pending-task", "transcriptProtocolVersion":2}))
        .await
        .unwrap();
    assert_eq!(modern["transcriptProtocolVersion"], 2);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(modern["transfer"]["payload"].as_str().unwrap())
        .unwrap();
    let packed: Value =
        serde_json::from_reader(flate2::read::GzDecoder::new(bytes.as_slice())).unwrap();
    assert_eq!(packed["transcript"], legacy);
    assert!(handler
        .transcript(json!({"taskId":"pending-task", "transcriptProtocolVersion":99}))
        .await
        .is_err());
    fs::remove_dir_all(root).unwrap();
}

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

#[cfg(unix)]
#[test]
fn named_home_transcript_refresh_does_not_acquire_a_writer() {
    use std::os::unix::fs::PermissionsExt;

    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
    let root = tempfile::tempdir().unwrap();
    let _env: Vec<_> = [
        "HOME",
        "CODEX_HOME",
        "WEGENT_CODEX_HOME",
        "WEGENT_EXECUTOR_HOME",
        "WEGENT_WORKBENCH_HOME",
        "WEGENT_CAPABILITIES_HOME",
    ]
    .into_iter()
    .map(|key| {
        let directory = root.path().join(key);
        fs::create_dir_all(&directory).unwrap();
        ScalarEnv::set(key, directory.to_str().unwrap())
    })
    .collect();
    let binary = root.path().join("codex-reader.sh");
    let log = root.path().join("requests.jsonl");
    fs::write(&binary, format!(r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{}'
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  printf '{{"id":%s,"result":{{"thread":{{"id":"thread-1","turns":[]}},"data":[],"nextCursor":null}}}}\n' "$id"
  case "$line" in *'"method":"test/stop"'*) exit 0;; esac
done
"#, log.display())).unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("device-1", binary.to_str().unwrap());
    handler.store = RuntimeWorkStore::new(root.path().join("index.json"));
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".into(),
        root.path().join("project").display().to_string(),
        "Task".into(),
    );
    link.thread_id = Some("thread-1".into());
    link.running = false;
    link.status = "done".into();
    link.runtime_handle["executionRequest"] = json!({
        "team_id": 1, "team_name": "reviewer", "team_namespace": "default",
        "user_name": "test-user", "bot": [{"id": 1, "shell_type": "Codex"}],
    });
    let client = handler
        .codex_app_server
        .for_request(&runtime_event_request_from_link(&link))
        .unwrap();
    handler.upsert_local_task(link);
    let result = handler
        .transcript(json!({"taskId": "task-1", "refresh": true}))
        .await;
    client.request("test/stop", json!({})).await.unwrap();
    assert!(result.is_ok(), "{result:?}");
    let calls: Vec<Value> = fs::read_to_string(log)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(calls.iter().any(|call| call["method"] == "thread/read"));
    assert!(calls
        .iter()
        .any(|call| call["method"] == "thread/turns/list"));
    assert!(!calls.iter().any(|call| call["method"] == "thread/resume"));
        });
}
