// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn runtime_tasks_create_ephemeral_codex_thread_hidden_from_task_list() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-ephemeral-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-ephemeral-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-ephemeral-log", "jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let parent_path = log_path.with_extension("parent.jsonl");
    write_source_rollout(&parent_path, "parent-thread-1");
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let created = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "side-chat-1",
                "workspacePath": "/tmp/project",
                "message": "quick side question",
                "ephemeral": true,
                "execution": {
                    "workspace": {
                        "source": "git_worktree",
                        "branch": "feature/side-chat"
                    }
                },
                "sideSource": {
                    "deviceId": "device-1",
                    "taskId": "main-task-1",
                    "workspacePath": "/tmp/project",
                    "runtimeHandle": {
                        "threadId": "parent-thread-1",
                        "threadPath": parent_path
                    }
                },
                "executionRequest": {
                    "task_id": "side-chat-1",
                    "subtask_id": "side-turn-1",
                    "prompt": "quick side question",
                    "project_workspace_path": "/tmp/project",
                    "workspace_source": "git_worktree",
                    "ephemeral": true,
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses"
                    }
                }
            }
        }))
        .await
        .expect("ephemeral create should be accepted");
    assert_eq!(created["accepted"], true);
    wait_for_codex_call(&log_path, "thread/fork").await;
    wait_for_codex_call(&log_path, "thread/inject_items").await;
    wait_for_codex_call(&log_path, "turn/start").await;

    let calls = read_json_lines(&log_path);
    let fork_call = calls
        .iter()
        .find(|call| call["method"] == "thread/fork")
        .expect("thread/fork should be called");
    assert_eq!(fork_call["params"]["threadId"], "parent-thread-1");
    assert_eq!(fork_call["params"]["path"], json!(parent_path));
    assert_eq!(fork_call["params"]["cwd"], "/tmp/project");
    assert_eq!(fork_call["params"]["permissions"], ":danger-full-access");
    assert!(fork_call["params"].get("ephemeral").is_none());
    let inject_call = calls
        .iter()
        .find(|call| call["method"] == "thread/inject_items")
        .expect("thread/inject_items should be called");
    assert_eq!(inject_call["params"]["threadId"], "thread-1");
    let boundary_prompt = inject_call["params"]["items"][0]["content"][0]["text"]
        .as_str()
        .expect("side conversation boundary should be text");
    assert!(boundary_prompt.contains("Side conversation boundary."));
    assert!(boundary_prompt.contains(
        "Do not modify files, source, git state, permissions, configuration, or workspace state \
         unless the user explicitly asks for that mutation after this boundary."
    ));
    assert!(boundary_prompt.contains(
        "If the user explicitly requests a mutation, keep it minimal, local to the request"
    ));
    assert!(calls.iter().all(|call| call["method"] != "thread/start"));
    assert!(calls.iter().all(|call| call["method"] != "thread/name/set"));
    assert!(calls.iter().all(|call| call["method"] != "thread/goal/set"));

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("runtime task list should succeed");
    assert_eq!(listed["success"], true);
    assert!(listed["workspaces"]
        .as_array()
        .is_some_and(|workspaces| workspaces.is_empty()));
}

#[tokio::test]
async fn runtime_tasks_wait_for_a_running_source_turn_before_forking_ephemeral_chat() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-side-source-ready-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-side-source-ready-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-side-source-ready-log", "jsonl");
    let fake_codex = write_fake_codex_delayed_source_turn(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let source = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "source-task",
                "workspacePath": "/tmp/project",
                "message": "source prompt",
                "executionRequest": codex_execution_request(
                    "source prompt",
                    "/tmp/project",
                    "gpt-5.5"
                )
            }
        }))
        .await
        .expect("source task should be accepted");
    assert_eq!(source["accepted"], true);
    wait_for_thread_mapping(&handler, "source-task", "source-thread").await;
    wait_for_method_count(&log_path, "turn/start", 1).await;

    let side = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "side-task",
                "workspacePath": "/tmp/project",
                "message": "side prompt",
                "ephemeral": true,
                "sideSource": {
                    "taskId": "source-task",
                    "workspacePath": "/tmp/project",
                    "runtimeHandle": {
                        "threadId": "source-thread"
                    }
                },
                "executionRequest": {
                    "task_id": "side-task",
                    "subtask_id": "side-turn",
                    "prompt": "side prompt",
                    "project_workspace_path": "/tmp/project",
                    "ephemeral": true,
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses"
                    }
                }
            }
        }))
        .await
        .expect("side task should be accepted after the source turn starts");
    assert_eq!(side["accepted"], true);

    wait_for_method_count(&log_path, "turn/start", 2).await;
    wait_until_task_idle(&handler, "side-task").await;
    let calls = read_json_lines(&log_path);
    let forks: Vec<_> = calls
        .iter()
        .filter(|call| call["method"] == "thread/fork")
        .collect();
    assert_eq!(
        forks.len(),
        1,
        "the source must become durable before the first fork attempt"
    );
    assert_eq!(forks[0]["params"]["threadId"], "source-thread");
    assert_eq!(
        forks[0]["params"]["path"],
        json!(log_path.with_extension("source.jsonl"))
    );
}

fn write_fake_codex_delayed_source_turn(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-delayed-source-turn", "sh");
    let source_path = log_path.with_extension("source.jsonl");
    fs::write(&source_path, b"").unwrap();
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
SOURCE_PATH='{}'
turn_count=0
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/list"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"data":[{{"id":"source-thread","cwd":"/tmp/project","name":"Source task","preview":"source","path":{},"createdAt":1780000000,"updatedAt":1780000060,"status":"active","turns":[]}}],"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"source-thread"}}}}}}'
      ;;
    *'"method":"thread/fork"'*)
      if [ -s "$SOURCE_PATH" ]; then
        printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"side-thread"}}}}}}'
      else
        printf '%s\n' '{{"id":'"$request_id"',"error":{{"message":"rollout at /tmp/codex/source-thread.jsonl is empty"}}}}'
      fi
      ;;
    *'"method":"thread/inject_items"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      ;;
    *'"method":"thread/name/set"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      ;;
    *'"method":"turn/start"'*)
      turn_count=$((turn_count + 1))
      if [ "$turn_count" -eq 1 ]; then
        (
          sleep 0.2
          printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"source-turn","status":"inProgress"}}}}}}'
          printf '%s\n' '{{"method":"turn/started","params":{{"threadId":"source-thread","turn":{{"id":"source-turn","status":"inProgress"}}}}}}'
          sleep 0.2
          printf '%s\n' '{{"type":"session_meta","payload":{{"id":"source-thread"}}}}' > "$SOURCE_PATH"
          printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"threadId":"source-thread","turnId":"source-turn","delta":"source done","phase":"finalAnswer"}}}}'
          printf '%s\n' '{{"method":"turn/completed","params":{{"threadId":"source-thread","turn":{{"id":"source-turn","status":"completed"}}}}}}'
        ) &
      else
        printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"side-turn","status":"inProgress"}}}}}}'
        printf '%s\n' '{{"method":"turn/started","params":{{"threadId":"side-thread","turn":{{"id":"side-turn","status":"inProgress"}}}}}}'
        printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"threadId":"side-thread","turnId":"side-turn","delta":"side done","phase":"finalAnswer"}}}}'
        printf '%s\n' '{{"method":"turn/completed","params":{{"threadId":"side-thread","turn":{{"id":"side-turn","status":"completed"}}}}}}'
      fi
      ;;
  esac
done
"#,
        log_path.display(),
        source_path.display(),
        json!(source_path)
    );
    write_executable(&path, &content);
    path
}

pub(super) fn write_source_rollout(path: &Path, thread_id: &str) {
    fs::write(
        path,
        format!(
            "{}\n",
            json!({"type":"session_meta","payload":{"id":thread_id}})
        ),
    )
    .unwrap();
}
