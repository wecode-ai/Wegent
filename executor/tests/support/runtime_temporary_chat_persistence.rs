// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use wegent_executor::services::capability_activation;

#[tokio::test]
async fn auxiliary_text_generation_discards_temporary_chat_persistence() {
    let _lock = env_lock().await;
    let root = tempfile::tempdir().unwrap();
    let _environment = [
        ("HOME", "home"),
        ("WEGENT_EXECUTOR_HOME", "executor"),
        ("WEGENT_WORKBENCH_HOME", "workbench"),
        ("WEGENT_CAPABILITIES_HOME", "capabilities"),
        ("WEGENT_CODEX_HOME", "codex"),
        ("CODEX_HOME", "codex"),
        ("CODEX_SQLITE_HOME", "sqlite"),
    ]
    .map(|(key, child)| {
        let path = root.path().join(child);
        fs::create_dir_all(&path).unwrap();
        EnvGuard::set(key, path.to_str().unwrap())
    });
    let workspace = root.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let log_path = root.path().join("rpc.jsonl");
    let binary = write_persistent_temporary_codex(root.path(), &log_path, &workspace);
    let handler = RuntimeWorkRpcHandler::new("device-1", binary.display().to_string());
    let mut request =
        codex_execution_request("suggest a reply", workspace.to_str().unwrap(), "gpt-5.5");
    request["persist_runtime_thread"] = json!(true);

    let generated = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.text.generate",
            "payload": {"executionRequest": request},
        }))
        .await
        .unwrap();

    assert_eq!(generated["content"], "saved answer 1");
    let calls = read_json_lines(&log_path);
    let started = calls
        .iter()
        .find(|call| call["method"] == "thread/start")
        .expect("auxiliary generation must start a native thread");
    assert_eq!(started["params"]["ephemeral"], true);
    CodexAppServerClient::new(binary.display().to_string())
        .restart()
        .await;
}

#[tokio::test]
async fn temporary_chat_restores_history_and_continues_after_capability_reload() {
    let _lock = env_lock().await;
    let root = tempfile::tempdir().unwrap();
    let _environment = [
        ("HOME", "home"),
        ("WEGENT_EXECUTOR_HOME", "executor"),
        ("WEGENT_WORKBENCH_HOME", "workbench"),
        ("WEGENT_CAPABILITIES_HOME", "capabilities"),
        ("WEGENT_CODEX_HOME", "codex"),
        ("CODEX_HOME", "codex"),
        ("CODEX_SQLITE_HOME", "sqlite"),
    ]
    .map(|(key, child)| {
        let path = root.path().join(child);
        fs::create_dir_all(&path).unwrap();
        EnvGuard::set(key, path.to_str().unwrap())
    });
    let workspace = root.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let log_path = root.path().join("rpc.jsonl");
    let binary = write_persistent_temporary_codex(root.path(), &log_path, &workspace);
    let (event_tx, mut events) = broadcast::channel(64);
    let handler = RuntimeWorkRpcHandler::with_event_sender(
        "device-1",
        binary.display().to_string(),
        event_tx,
    );
    let mut request =
        codex_execution_request("side question", workspace.to_str().unwrap(), "gpt-5.5");
    request["task_id"] = json!("side-chat");
    request["subtask_id"] = json!("side-turn-1");
    request["ephemeral"] = json!(true);
    let created = handler.handle_runtime_rpc(json!({
        "method": "runtime.tasks.create",
        "payload": {
            "taskId": "side-chat", "workspacePath": workspace, "message": "side question",
            "ephemeral": true,
            "clientUserMessageId": "side-user-1",
            "sideSource": {"deviceId":"device-1", "taskId":"main-task", "workspacePath":workspace,
                "runtimeHandle":{"threadId":"parent", "threadPath":root.path().join("parent.jsonl")}},
            "executionRequest": request,
        }
    })).await.unwrap();
    assert_eq!(created["accepted"], true);
    let completed = recv_events_until(&mut events, |items| {
        items
            .iter()
            .any(|item| item["event"] == "response.completed")
    })
    .await;
    assert!(completed
        .iter()
        .all(|item| item["event"] != "response.failed"));
    assert_eq!(
        created["runtimeHandle"]["executionRequest"]["persist_runtime_thread"],
        true
    );

    // A real capability change must load a new process without losing the conversation.
    let activation = capability_activation::activate().await;
    capability_activation::mark_changed();
    drop(activation);
    let transcript = handler
        .handle_runtime_rpc(json!({
            "method":"runtime.tasks.transcript",
            "payload":{"taskId":"side-chat", "workspacePath":workspace, "refresh":true}
        }))
        .await
        .unwrap();
    assert_eq!(transcript["success"], true);
    assert_side_chat_messages(
        &transcript,
        &[("user", "side question"), ("assistant", "saved answer 1")],
    );

    request["subtask_id"] = json!("side-turn-2");
    request["prompt"] = json!("follow up");
    request["model_config"]["model_id"] = json!("gpt-5.6");
    let sent = handler
        .handle_runtime_rpc(json!({
            "method":"runtime.tasks.send",
            "payload":{"taskId":"side-chat", "workspacePath":workspace,
                "message":"follow up", "clientUserMessageId":"side-user-2", "executionRequest":request}
        }))
        .await
        .unwrap();
    assert_eq!(sent["accepted"], true);
    let completed = recv_events_until(&mut events, |items| {
        items
            .iter()
            .any(|item| item["event"] == "response.completed")
    })
    .await;
    assert!(completed
        .iter()
        .all(|item| item["event"] != "response.failed"));
    assert_eq!(
        fs::read_to_string(root.path().join("turn-count"))
            .unwrap()
            .trim(),
        "2"
    );

    let transcript = handler
        .handle_runtime_rpc(json!({
            "method":"runtime.tasks.transcript",
            "payload":{"taskId":"side-chat", "workspacePath":workspace, "refresh":true}
        }))
        .await
        .unwrap();
    assert_side_chat_messages(
        &transcript,
        &[
            ("user", "side question"),
            ("assistant", "saved answer 1"),
            ("user", "follow up"),
            ("assistant", "saved answer 2"),
        ],
    );
    let navigation = handler
        .handle_runtime_rpc(json!({
            "method":"runtime.tasks.transcript",
            "payload":{"taskId":"side-chat", "workspacePath":workspace, "navigationOnly":true, "refresh":true}
        }))
        .await
        .unwrap();
    assert_eq!(navigation["turnNavigation"].as_array().unwrap().len(), 2);
    let search = handler
        .handle_runtime_rpc(json!({
            "method":"runtime.tasks.transcript.search",
            "payload":{"taskId":"side-chat", "query":"saved answer"}
        }))
        .await
        .unwrap();
    assert_eq!(search["totalMatches"], 2);
    let user_search = handler
        .handle_runtime_rpc(json!({
            "method":"runtime.tasks.transcript.search",
            "payload":{"taskId":"side-chat", "query":"side question"}
        }))
        .await
        .unwrap();
    assert_eq!(user_search["totalMatches"], 1);

    let listed = handler
        .handle_runtime_rpc(json!({"method":"runtime.tasks.list", "payload":{}}))
        .await
        .unwrap();
    assert!(
        listed["workspaces"].as_array().unwrap().is_empty(),
        "persisted temporary threads must stay hidden: {listed}"
    );
    let calls = read_json_lines(&log_path);
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "thread/fork")
            .count(),
        1
    );
    assert!(calls
        .iter()
        .find(|call| call["method"] == "thread/fork")
        .unwrap()["params"]
        .get("ephemeral")
        .is_none());
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "initialize")
            .count(),
        2
    );
    assert!(calls.iter().any(|call| call["method"] == "thread/resume"));
    assert!(
        calls
            .iter()
            .any(|call| call["method"] == "thread/resume" && call["params"]["model"] == "gpt-5.6"),
        "follow-up must apply the new model while resuming the same history"
    );
    assert!(
        !calls.iter().any(|call| matches!(
            call["method"].as_str(),
            Some("thread/read" | "thread/turns/list" | "thread/timeline/list")
        )),
        "side-chat rendering must not expose inherited parent history"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "thread/inject_items")
            .count(),
        1
    );
    CodexAppServerClient::new(binary.display().to_string())
        .restart()
        .await;
}

fn assert_side_chat_messages(transcript: &Value, expected: &[(&str, &str)]) {
    let actual = transcript["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| {
            (
                message["role"].as_str().unwrap(),
                message["content"].as_str().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        actual, expected,
        "temporary history must include both sides in order"
    );
}

fn write_persistent_temporary_codex(root: &Path, log_path: &Path, workspace: &Path) -> PathBuf {
    let binary = root.join("fake-codex.sh");
    let script = r#"#!/bin/sh
LOG_PATH='@LOG_PATH@'
STATE_ROOT='@STATE_ROOT@'
thread_loaded=0
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialized"'*) continue ;;
    *'"method":"thread/start"'*)
      case "$line" in
        *'"ephemeral":true'*) ;;
        *) printf '{"id":%s,"error":{"message":"auxiliary threads must be ephemeral"}}\n' "$request_id"; continue ;;
      esac
      printf '0\n' > "$STATE_ROOT/turn-count"
      thread_loaded=1
      result='{"thread":{"id":"temporary-thread"}}'
      ;;
    *'"method":"thread/fork"'*)
      case "$line" in
        *'"ephemeral":true'*) printf '{"id":%s,"error":{"message":"temporary tasks require native persistence"}}\n' "$request_id"; continue ;;
      esac
      printf '0\n' > "$STATE_ROOT/turn-count"
      thread_loaded=1
      result='{"thread":{"id":"temporary-thread"}}'
      ;;
    *'"method":"thread/resume"'*)
      if [ ! -f "$STATE_ROOT/turn-count" ]; then
        printf '{"id":%s,"error":{"message":"no rollout found for temporary-thread"}}\n' "$request_id"
        continue
      fi
      thread_loaded=1
      result='{"thread":{"id":"temporary-thread"}}'
      ;;
    *'"method":"thread/list"'*)
      result='{"data":[{"id":"temporary-thread","cwd":"@WORKSPACE@","name":"Side chat","createdAt":1780000000,"updatedAt":1780000060,"status":"idle"}],"nextCursor":null}'
      ;;
    *'"method":"thread/read"'*)
      result='{"thread":{"id":"temporary-thread","cwd":"@WORKSPACE@","turns":[]}}'
      ;;
    *'"method":"thread/turns/list"'*)
      result='{"data":[{"id":"turn-1","status":"completed","itemsView":"notLoaded"}],"nextCursor":null,"backwardsCursor":null}'
      ;;
    *'"method":"thread/items/list"'*)
      result='{"data":[{"turnId":"turn-1","item":{"id":"user-1","type":"userMessage","content":[{"type":"text","text":"side question"}]}},{"turnId":"turn-1","item":{"id":"answer-1","type":"agentMessage","text":"saved answer 1","phase":"final_answer"}}],"nextCursor":null,"backwardsCursor":null}'
      ;;
    *'"method":"turn/start"'*)
      if [ "$thread_loaded" -eq 0 ]; then
        printf '{"id":%s,"error":{"message":"thread not found: temporary-thread"}}\n' "$request_id"
        continue
      fi
      turn_count=$(cat "$STATE_ROOT/turn-count")
      turn_count=$((turn_count + 1))
      printf '%s\n' "$turn_count" > "$STATE_ROOT/turn-count"
      printf '{"id":%s,"result":{"turn":{"id":"turn-%s","status":"inProgress"}}}\n' "$request_id" "$turn_count"
      printf '{"method":"turn/started","params":{"threadId":"temporary-thread","turn":{"id":"turn-%s","status":"inProgress"}}}\n' "$turn_count"
      printf '{"method":"item/started","params":{"threadId":"temporary-thread","turnId":"turn-%s","item":{"id":"answer-%s","type":"agentMessage","phase":"final_answer"}}}\n' "$turn_count" "$turn_count"
      printf '{"method":"item/agentMessage/delta","params":{"threadId":"temporary-thread","turnId":"turn-%s","itemId":"answer-%s","delta":"saved answer %s"}}\n' "$turn_count" "$turn_count" "$turn_count"
      printf '{"method":"item/completed","params":{"threadId":"temporary-thread","turnId":"turn-%s","item":{"id":"answer-%s","type":"agentMessage","text":"saved answer %s","phase":"final_answer"}}}\n' "$turn_count" "$turn_count" "$turn_count"
      printf '{"method":"turn/completed","params":{"threadId":"temporary-thread","turn":{"id":"turn-%s","status":"completed"}}}\n' "$turn_count"
      continue
      ;;
    *'"method":"thread/unsubscribe"'*) thread_loaded=0; result='{}' ;;
    *) result='{}' ;;
  esac
  printf '{"id":%s,"result":%s}\n' "$request_id" "$result"
done
"#
    .replace("@LOG_PATH@", log_path.to_str().unwrap())
    .replace("@STATE_ROOT@", root.to_str().unwrap())
    .replace("@WORKSPACE@", workspace.to_str().unwrap());
    fs::write(&binary, script).unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    binary
}
