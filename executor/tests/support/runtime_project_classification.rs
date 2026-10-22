// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn named_project_inside_codex_directory_survives_list_refresh_and_restart() {
    let _lock = env_lock().await;
    let executor_home = temp_path("named-project-executor", "dir");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let codex_home = temp_path("named-project-codex", "dir");
    let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
    let project_root = executor_home.join("Documents/Codex/2026-10-16/repo");
    fs::create_dir_all(&project_root).unwrap();
    let log_path = temp_path("named-project-calls", "jsonl");
    let fake_codex = write_fake_codex_empty(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let created = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.projects.upsert_local",
            "payload": {
                "runtime": "codex",
                "projectKey": "named-project",
                "name": "Named project",
                "roots": [project_root]
            }
        }))
        .await
        .expect("named project creation should succeed");
    assert_eq!(created["accepted"], true);
    let restarted = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    for current in [&handler, &handler, &restarted] {
        let listed = current
            .handle_runtime_rpc(json!({
                "method": "runtime.tasks.list",
                "payload": {}
            }))
            .await
            .expect("registered projects should list after refresh and restart");
        let workspaces = listed["workspaces"].as_array().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0]["projectKey"], created["projectKey"]);
        assert_eq!(
            workspaces[0]["workspacePath"],
            project_root.display().to_string()
        );
        assert_eq!(workspaces[0]["workspaceKind"], "workspace");
        assert_eq!(workspaces[0]["projectSource"], "local_project");
        assert_eq!(workspaces[0]["tasks"], json!([]));
    }
    assert!(read_json_lines(&log_path)
        .iter()
        .all(|call| call["method"] != "thread/start"));
}
