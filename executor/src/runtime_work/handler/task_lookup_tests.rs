// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn task_lookup_reads_project_task_without_starting_provider_or_listing() {
    let (handler, root) = isolated_runtime_work_handler("api-task-lookup");
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "workspace-task".into(),
        thread_id: Some("original-thread".into()),
        workspace_path: "/projects/original".into(),
        runtime_handle: json!({
            "wegentTeam": {"id": 42},
            "modelSelection": {
                "modelName": "model-1",
                "options": {"permissionMode": "read-only"}
            },
            "executionRequest": {"system_prompt": "private profile"},
            "messages": [{"content": "private transcript"}]
        }),
        ..RuntimeTaskLink::default()
    });

    let result = handler
        .dispatch("runtime.tasks.get", json!({"taskId": "workspace-task"}))
        .await
        .unwrap();

    assert_eq!(result["success"], true);
    assert_eq!(result["task"]["taskId"], "workspace-task");
    assert_eq!(result["task"]["workspaceKind"], "workspace");
    assert_eq!(result["task"]["runtimeHandle"]["wegentTeam"]["id"], 42);
    assert_eq!(
        result["task"]["runtimeHandle"]["threadId"],
        "original-thread"
    );
    assert!(!result.to_string().contains("private"));
    assert!(!should_resume_persisted_turns_before_rpc(
        "runtime.tasks.get"
    ));
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn task_lookup_reports_missing_and_archived_without_device_offline_error() {
    let (handler, root) = isolated_runtime_work_handler("api-missing-task");
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "archived".into(),
        status: "archived".into(),
        ..RuntimeTaskLink::default()
    });
    for task_id in ["missing", "archived"] {
        let result = handler
            .dispatch("runtime.tasks.get", json!({"taskId": task_id}))
            .await
            .unwrap();
        assert_eq!(result["success"], false);
        assert_eq!(result["code"], "task_not_found");
    }
    assert!(handler
        .dispatch("runtime.tasks.get", json!({}))
        .await
        .is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn task_lookup_uses_same_live_execution_state_as_desktop() {
    let (handler, root) = isolated_runtime_work_handler("api-running-task");
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "task-1".into(),
        ..RuntimeTaskLink::default()
    });
    let execution_id = start_test_execution(&handler, "task-1");
    let result = handler.get_task(&json!({"taskId": "task-1"})).unwrap();
    assert_eq!(result["task"]["running"], true);
    handler.finish_local_task_execution("task-1", execution_id);
    fs::remove_dir_all(root).unwrap();
}
