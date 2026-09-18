// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

async fn list_workspaces(handler: &RuntimeWorkRpcHandler, prefer_cached: bool) -> Vec<Value> {
    let response = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {"preferCached": prefer_cached}
        }))
        .await
        .expect("task list should succeed");
    assert_eq!(response["success"], true);
    response["workspaces"].as_array().unwrap().clone()
}

async fn mutate_workspace(handler: &RuntimeWorkRpcHandler, method: &str, path: &Path) {
    let response = handler
        .handle_runtime_rpc(json!({
            "method": method,
            "payload": {"runtime": "codex", "workspacePath": path}
        }))
        .await
        .expect("workspace mutation should succeed");
    assert_eq!(response["accepted"], true);
}

#[tokio::test]
async fn removed_claude_project_stays_removed_after_refresh_and_restart() {
    let _lock = env_lock().await;
    let fixture = tempfile::tempdir().unwrap();
    let executor_home = fixture.path().join("executor");
    let codex_home = fixture.path().join("codex");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", executor_home.to_str().unwrap());
    let _codex_home = EnvGuard::set("CODEX_HOME", codex_home.to_str().unwrap());
    let project_a = fixture.path().join("project-a");
    let project_b = fixture.path().join("project-b");
    let chat = fixture.path().join("Codex").join("standalone-chat");
    for path in [&project_a, &project_b, &chat] {
        fs::create_dir_all(path).unwrap();
    }
    let source_file = project_a.join("keep.txt");
    fs::write(&source_file, "Keep project files").unwrap();
    let index_path = executor_home.join("runtime-work").join("index.json");
    fs::create_dir_all(index_path.parent().unwrap()).unwrap();
    fs::write(
        &index_path,
        serde_json::to_vec(&json!({
            "version": 1,
            "tasks": {
                "claude-project-task": {
                    "local_task_id": "claude-project-task",
                    "thread_id": "claude-project-session",
                    "workspace_path": project_a,
                    "title": "Project conversation",
                    "runtime": "claudecode",
                    "status": "completed"
                },
                "claude-chat-task": {
                    "local_task_id": "claude-chat-task",
                    "thread_id": "claude-chat-session",
                    "workspace_path": chat,
                    "title": "Standalone conversation",
                    "runtime": "claudecode",
                    "status": "completed"
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let fake_codex = write_fake_codex_empty(&fixture.path().join("codex-calls.jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());
    for path in [&project_a, &project_b] {
        mutate_workspace(&handler, "runtime.workspaces.open", path).await;
    }
    let initial = list_workspaces(&handler, false).await;
    assert_eq!(initial.len(), 3);
    let project = initial
        .iter()
        .find(|workspace| workspace["workspacePath"] == json!(project_a))
        .unwrap();
    assert_eq!(project["tasks"][0]["taskId"], "claude-project-task");

    // Removing B triggers the second refresh shown in the user's recording.
    for (path, expected_count) in [(&project_a, 2), (&project_b, 1)] {
        mutate_workspace(&handler, "runtime.workspaces.remove", path).await;
        for prefer_cached in [false, true] {
            let workspaces = list_workspaces(&handler, prefer_cached).await;
            assert_eq!(workspaces.len(), expected_count);
            assert!(workspaces
                .iter()
                .all(|workspace| workspace["workspacePath"] != json!(project_a)));
            assert!(workspaces.iter().any(|workspace| {
                workspace["workspacePath"] == json!(chat)
                    && workspace["tasks"][0]["taskId"] == "claude-chat-task"
            }));
        }
    }
    drop(handler);

    let restarted = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());
    let workspaces = list_workspaces(&restarted, false).await;
    assert_eq!(workspaces.len(), 1);
    assert_eq!(workspaces[0]["workspacePath"], json!(chat));

    // Removal changes visibility; reopening must recover the original conversation.
    mutate_workspace(&restarted, "runtime.workspaces.open", &project_a).await;
    let reopened = list_workspaces(&restarted, false).await;
    assert_eq!(reopened.len(), 2);
    let project = reopened
        .iter()
        .find(|workspace| workspace["workspacePath"] == json!(project_a))
        .unwrap();
    assert_eq!(project["tasks"][0]["taskId"], "claude-project-task");
    assert_eq!(
        fs::read_to_string(source_file).unwrap(),
        "Keep project files"
    );
    drop(restarted);
    fs::remove_file(fake_codex).unwrap();
}
