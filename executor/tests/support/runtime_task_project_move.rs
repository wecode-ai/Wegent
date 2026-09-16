// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn resumed_tasks_preserve_sidebar_moves_and_explicit_removal() {
    let _lock = env_lock().await;
    for projectless in [false, true] {
        let executor_home = temp_path("runtime-move-resume-home", "dir");
        let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
        let codex_home = temp_path("runtime-move-resume-codex", "dir");
        let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
        fs::create_dir_all(&codex_home).unwrap();
        let state_path = codex_home.join(".codex-global-state.json");
        let projectless_ids = if projectless {
            json!(["thread-1"])
        } else {
            json!([])
        };
        fs::write(
            &state_path,
            serde_json::to_vec(&json!({
                "electron-saved-workspace-roots": ["/tmp/source", "/tmp/target"],
                "thread-project-assignments": {"thread-1": {"projectId": "/tmp/target"}},
                "thread-workspace-root-hints": {"thread-1": "/tmp/target"},
                "projectless-thread-ids": projectless_ids
            }))
            .unwrap(),
        )
        .unwrap();
        seed_persisted_runtime_task_at_workspace(
            &executor_home,
            "local-task-1",
            "thread-1",
            "/tmp/source",
        );
        let log_path = temp_path("runtime-move-resume-log", "jsonl");
        let fake_codex = write_fake_codex(&log_path);
        let (event_tx, mut events) = broadcast::channel(64);
        let handler = RuntimeWorkRpcHandler::with_event_sender(
            "device-1",
            fake_codex.display().to_string(),
            event_tx,
        );
        let mut request = codex_execution_request("continue", "/tmp/source", "gpt-5.5");
        request["runtime_project_key"] = json!("/tmp/source");
        let sent = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.tasks.send",
                "payload": {
                    "taskId": "local-task-1",
                    "workspacePath": "/tmp/source",
                    "message": "continue",
                    "executionRequest": request
                }
            }))
            .await
            .unwrap();
        assert_eq!(sent["accepted"], true);
        wait_for_turn_count(&log_path, 1).await;
        recv_events_until(&mut events, |received| {
            find_runtime_event(received, "response.completed", |_| true).is_some()
        })
        .await;
        let state: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
        assert_eq!(
            state["thread-project-assignments"]["thread-1"]["projectId"],
            "/tmp/target"
        );
        assert_eq!(
            state["thread-workspace-root-hints"]["thread-1"],
            "/tmp/target"
        );
        assert_eq!(state["projectless-thread-ids"], projectless_ids);
        let calls = read_json_lines(&log_path);
        let resume = calls
            .iter()
            .find(|call| call["method"] == "thread/resume")
            .unwrap();
        assert_eq!(resume["params"]["cwd"], "/tmp/source");
    }
}
