use super::*;

#[tokio::test]
async fn server_created_user_identity_survives_native_transcript_recovery() {
    let (handler, root) = isolated_runtime_work_handler("server-user-identity");
    for (task_id, client_id) in [
        ("server-created", None),
        ("composer-created", Some("composer-user")),
    ] {
        let mut payload = json!({
            "taskId": task_id,
            "workspacePath": root.join(task_id),
            "message": "The same prompt may be sent more than once",
            "executionRequest": ExecutionRequest {
                subtask_id: "request-subtask".into(),
                ..ExecutionRequest::default()
            },
        });
        if let Some(client_id) = client_id {
            payload["clientUserMessageId"] = json!(client_id);
        }
        handler.create_task(payload).await.unwrap();
        let link = handler.local_task_link(task_id).unwrap();
        let cached = cached_messages(&link);
        let expected = client_id
            .map(str::to_owned)
            .unwrap_or_else(|| cached[0]["id"].as_str().unwrap().to_owned());
        assert_eq!(cached[0]["clientUserMessageId"], expected);
        assert_eq!(
            link.runtime_handle["executionRequest"]["client_user_message_id"],
            expected
        );
        handler.record_runtime_turn_id(task_id, "request-subtask", "native-turn", Some(&expected));
        let link = handler.local_task_link(task_id).unwrap();
        let presentations = user_message_presentations(&link);
        let mut native = vec![json!({
            "id": "native-user-item", "role": "user", "turnId": "native-turn",
            "content": "The same prompt may be sent more than once",
        })];
        bind_native_user_presentations(&mut native, &presentations);
        attach_user_message_presentations(&mut native, presentations);
        assert_eq!(native.len(), 1);
        assert_eq!(native[0]["clientUserMessageId"], expected);
    }
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn history_resume_restores_task_shell_identity_before_the_next_turn() {
    use std::os::unix::fs::PermissionsExt;

    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env: Vec<_> = [
                "HOME", "CODEX_HOME", "WEGENT_CODEX_HOME", "WEGENT_EXECUTOR_HOME",
                "WEGENT_WORKBENCH_HOME", "WEGENT_CAPABILITIES_HOME",
            ].into_iter().map(|key| {
                let directory = root.path().join(key);
                fs::create_dir_all(&directory).unwrap();
                ScalarEnv::set(key, directory.to_str().unwrap())
            }).collect();
            let _browser_url = ScalarEnv::set(
                "WEWORK_EMBEDDED_BROWSER_BRIDGE_URL", "http://127.0.0.1:9",
            );
            let binary = root.path().join("codex-history.sh");
            let log = root.path().join("requests.jsonl");
            fs::write(&binary, crate::test_env::with_codex_bundled_catalog(&format!(r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{}'
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  printf '{{"id":%s,"result":{{"thread":{{"id":"thread-1","turns":[]}},"data":[],"nextCursor":null}}}}\n' "$id"
  case "$line" in *'"method":"test/stop"'*) exit 0;; esac
done
"#, log.display()))).unwrap();
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
            let handler = RuntimeWorkRpcHandler::new("device-1", binary.to_str().unwrap())
                .with_backend_connection(Arc::new(Mutex::new(Some(ConnectionConfig {
                    backend_url: "https://backend.example.com".into(),
                    socket_url: "wss://backend.example.com".into(),
                    auth_token: "current-user-token".into(),
                    runtime_auth_token: "current-runtime-token".into(),
                }))));
            let link = RuntimeTaskLink::new_pending(
                "restored-task".into(), root.path().join("project").display().to_string(),
                "Restored task".into(),
            );
            handler.resume_codex_thread_for_action(&link, "thread-1").await.unwrap();
            handler.codex_app_server.request("test/stop", json!({})).await.unwrap();
            let calls: Vec<Value> = fs::read_to_string(log).unwrap().lines()
                .map(|line| serde_json::from_str(line).unwrap()).collect();
            let resume = calls.iter().find(|call| call["method"] == "thread/resume").unwrap();
            let config = &resume["params"]["config"];
            assert_eq!(config["shell_environment_policy.set.WEGENT_TASK_ID"], "restored-task");
            assert_eq!(config["shell_environment_policy.set.WEGENT_TASK_WORKSPACE"], link.workspace_path);
            assert_eq!(config["shell_environment_policy.set.WEGENT_EXECUTOR_BINARY"],
                std::env::current_exe().unwrap().to_string_lossy().as_ref());
            assert_eq!(config["shell_environment_policy.set.AUTH_TOKEN"], "current-user-token");
            assert_eq!(config["shell_environment_policy.set.WEGENT_RUNTIME_AUTH_TOKEN"], "current-runtime-token");
            assert_eq!(resume["params"]["excludeTurns"], true);
            // Native resume can start an active Goal before a regular turn restores MCP.
            assert_eq!(config["mcp_servers.wework_browser.enabled"], true);
            assert!(config["mcp_servers.wework_browser.url"].as_str().unwrap().ends_with("/mcp"));
            assert_eq!(config["mcp_servers.wework_browser.http_headers.X-Wework-Browser-Label"],
                "workspace-browser-restored-task");
            assert_eq!(config["mcp_servers.wework_browser.env_http_headers.Authorization"],
                "WEGENT_CODEX_BROWSER_MCP_AUTHORIZATION");
            assert!(config["mcp_servers.wework_space.url"].is_string());
            assert_eq!(config["features.non_prefixed_mcp_tool_names"], true);
            for field in ["model", "modelProvider", "developerInstructions", "effort"] {
                assert!(resume["params"].get(field).is_none(), "History must preserve {field}");
            }
            assert!(link.runtime_handle.get("executionRequest").is_none());
        });
}

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

#[cfg(unix)]
#[test]
fn archived_transcript_refresh_reads_history_without_resuming() {
    use std::os::unix::fs::PermissionsExt;

    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env: Vec<_> = [
                "HOME", "CODEX_HOME", "WEGENT_CODEX_HOME", "WEGENT_EXECUTOR_HOME",
                "WEGENT_WORKBENCH_HOME", "WEGENT_CAPABILITIES_HOME",
            ].into_iter().map(|key| {
                let directory = root.path().join(key);
                fs::create_dir_all(&directory).unwrap();
                ScalarEnv::set(key, directory.to_str().unwrap())
            }).collect();
            let binary = root.path().join("codex-archive-reader.sh");
            let log = root.path().join("requests.jsonl");
            fs::write(&binary, crate::test_env::with_codex_bundled_catalog(&format!(r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{}'
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  case "$line" in
    *'"method":"thread/resume"'*'"threadId":"archived-thread"'*)
      printf '{{"id":%s,"error":{{"code":-32600,"message":"thread archived-thread is archived"}}}}\n' "$id" ;;
    *'"method":"thread/turns/list"'*)
      printf '{{"id":%s,"result":{{"data":[{{"id":"turn-1","status":"completed","items":[{{"id":"answer-1","type":"agentMessage","text":"Saved native history","phase":"final_answer"}}]}}],"nextCursor":null}}}}\n' "$id" ;;
    *)
      printf '{{"id":%s,"result":{{"thread":{{"id":"archived-thread","turns":[]}}}}}}\n' "$id" ;;
  esac
  case "$line" in *'"method":"test/stop"'*) exit 0;; esac
done
"#, log.display()))).unwrap();
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
            let mut handler = RuntimeWorkRpcHandler::new("device-1", binary.to_str().unwrap());
            handler.store = RuntimeWorkStore::new(root.path().join("index.json"));
            let mut link = RuntimeTaskLink::new_pending(
                "archived-task".into(), root.path().join("project").display().to_string(),
                "Archived task".into(),
            );
            link.thread_id = Some("archived-thread".into());
            link.status = "archived".into();
            link.running = false;
            link.continuable = false;
            handler.upsert_local_task(link);
            for version in [1, 2] {
                for refresh in [false, true] {
                    let response = handler.read_thread_transcript(json!({
                        "taskId":"archived-task", "refresh":refresh,
                        "transcriptProtocolVersion":version,
                    }), None).await.unwrap();
                    assert!(response["messages"].as_array().unwrap().iter()
                        .any(|message| message["content"] == "Saved native history"));
                    assert_eq!(response["running"], false);
                }
            }
            let archived = handler.local_task_link("archived-task").unwrap();
            assert_eq!(archived.status, "archived");
            assert!(!archived.continuable);
            assert_eq!(archived.thread_id.as_deref(), Some("archived-thread"));

            let mut active = RuntimeTaskLink::new_pending(
                "active-task".into(), root.path().join("project").display().to_string(),
                "Active task".into(),
            );
            active.thread_id = Some("active-thread".into());
            active.status = "done".into();
            handler.upsert_local_task(active);
            handler.read_thread_transcript(json!({"taskId":"active-task","refresh":true}), None)
                .await.unwrap();
            handler.codex_app_server.request("test/stop", json!({})).await.unwrap();
            let calls: Vec<Value> = fs::read_to_string(log).unwrap().lines()
                .map(|line| serde_json::from_str(line).unwrap()).collect();
            let resumes: Vec<_> = calls.iter().filter(|call| call["method"] == "thread/resume").collect();
            assert_eq!(resumes.len(), 1);
            assert_eq!(resumes[0]["params"]["threadId"], "active-thread");
            assert!(!calls.iter().any(|call|
                matches!(call["method"].as_str(), Some("thread/unarchive" | "turn/start"))));
        });
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
    fs::write(&binary, crate::test_env::with_codex_bundled_catalog(&format!(r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{}'
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  printf '{{"id":%s,"result":{{"thread":{{"id":"thread-1","turns":[]}},"data":[],"nextCursor":null}}}}\n' "$id"
  case "$line" in *'"method":"test/stop"'*) exit 0;; esac
done
"#, log.display()))).unwrap();
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
