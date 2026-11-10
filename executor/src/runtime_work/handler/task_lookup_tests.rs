// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn continuation_identity_rejects_archived_and_deleted_tasks() {
    let (handler, root) = isolated_runtime_work_handler("identity-ineligible");
    for (task, thread, archived, deleted) in [
        ("archived", "archived-thread", true, None),
        (
            "deleted-local",
            "local-thread",
            false,
            Some("deleted-local"),
        ),
        (
            "deleted-thread",
            "deleted-thread-id",
            false,
            Some("deleted-thread-id"),
        ),
    ] {
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: task.into(),
            thread_id: Some(thread.into()),
            status: if archived { "archived" } else { "completed" }.into(),
            ..RuntimeTaskLink::default()
        });
        if let Some(id) = deleted {
            handler
                .store
                .mark_deleted_archived_task_ids(vec![id.to_owned()])
                .unwrap();
        }
        let error = handler
            .dispatch(
                "runtime.tasks.transcript",
                json!({"taskId": task, "identityOnly": true}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "not_found", "{task}");
    }
    assert!(!root.join("requests.jsonl").exists());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn continuation_identity_uses_metadata_while_history_workers_are_saturated() {
    for runtime in ["codex", "claude_code"] {
        let (handler, root) = isolated_runtime_work_handler(&format!("identity-{runtime}"));
        let origin = json!({"type":"project_task","cloudProjectId":"project","loopItemId":"issue"});
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "task-1".into(),
            runtime: runtime.into(),
            workspace_path: "/original/workspace".into(),
            runtime_handle: json!({
                "origin": origin,
                "executionRequest": {"system_prompt":"private profile"},
                "messages": [{"content":"private transcript"}]
            }),
            ..RuntimeTaskLink::default()
        });
        let workers = handler.transcript_test_workers.as_ref().unwrap().clone();
        let slots = (
            workers.clone().try_acquire_owned().unwrap(),
            workers.clone().try_acquire_owned().unwrap(),
        );

        let result = handler
            .dispatch(
                "runtime.tasks.transcript",
                json!({
                    "taskId":"task-1","identityOnly":true,"transcriptProtocolVersion":2,
                    "workspacePath":"/forged","threadId":"forged",
                    "runtimeHandle":{"origin":{"cloudProjectId":"forged"}}
                }),
            )
            .await
            .unwrap();

        assert_eq!(result["taskId"], "task-1");
        assert_eq!(result["workspacePath"], "/original/workspace");
        assert_eq!(result["runtime"], runtime);
        assert_eq!(result["origin"], origin);
        assert_eq!(result["turns"], json!([]));
        assert_eq!(result["messages"], json!([]));
        assert!(!result.to_string().contains("private"));
        assert!(!root.join("requests.jsonl").exists());
        assert_eq!(workers.available_permits(), 0);
        assert_eq!(
            handler
                .dispatch(
                    "runtime.tasks.transcript",
                    json!({
                        "taskId":"pending-task","transcriptProtocolVersion":2
                    })
                )
                .await
                .unwrap_err()
                .code,
            "runtime_read_busy"
        );
        assert_eq!(
            handler
                .dispatch(
                    "runtime.tasks.transcript",
                    json!({
                        "taskId":"missing","identityOnly":true
                    })
                )
                .await
                .unwrap_err()
                .code,
            "not_found"
        );
        drop(slots);
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn task_lookup_reads_project_task_without_starting_provider_or_listing() {
    let (handler, root) = isolated_runtime_work_handler("api-task-lookup");
    let origin = json!({
        "type":"project_task", "initiatedBy":"stand_in",
        "cloudProjectId":"project", "loopItemId":"issue", "projectStore":"local"
    });
    let change_requests = json!(["https://github.com/example/project/pull/1"]);
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "workspace-task".into(),
        thread_id: Some("original-thread".into()),
        workspace_path: "/projects/original".into(),
        runtime_handle: json!({
            "wegentTeam": {"id": 42},
            "origin": origin,
            "changeRequests": change_requests,
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
    assert_eq!(result["task"]["runtimeHandle"]["origin"], origin);
    assert_eq!(
        result["task"]["runtimeHandle"]["changeRequests"],
        change_requests
    );
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
async fn task_lookup_projects_current_workspace_git_info_without_provider_discovery() {
    let (handler, root) = isolated_runtime_work_handler("api-task-lookup-git");
    let workspace = root.join("workspace");
    let git_dir = workspace.join(".git");
    fs::create_dir_all(&git_dir).unwrap();
    fs::write(git_dir.join("HEAD"), "ref: refs/heads/feature/first\n").unwrap();
    fs::write(
        git_dir.join("config"),
        "[remote \"origin\"]\n\turl = https://github.com/example/project.git\n",
    )
    .unwrap();
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "git-task".into(),
        workspace_path: workspace.display().to_string(),
        ..RuntimeTaskLink::default()
    });

    let result = handler.get_task(&json!({"taskId":"git-task"})).unwrap();
    assert_eq!(result["task"]["gitInfo"]["currentBranch"], "feature/first");
    assert_eq!(
        result["task"]["gitInfo"]["originUrl"],
        "https://github.com/example/project.git"
    );
    fs::write(git_dir.join("HEAD"), "ref: refs/heads/feature/second\n").unwrap();
    let result = handler.get_task(&json!({"taskId":"git-task"})).unwrap();
    assert_eq!(result["task"]["gitInfo"]["currentBranch"], "feature/second");
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
        assert_eq!(
            result["code"],
            if task_id == "archived" {
                "task_archived"
            } else {
                "task_not_found"
            }
        );
    }
    assert!(handler
        .dispatch("runtime.tasks.get", json!({}))
        .await
        .is_err());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn task_model_selection_survives_cold_lookup_and_transcript_read() {
    let (mut handler, root) = isolated_runtime_work_handler("api-cold-model-lookup");
    for model in ["model-a", "model-b"] {
        let mut link =
            RuntimeTaskLink::new_pending(model.into(), "/projects/shared".into(), model.into());
        link.runtime_handle = json!({
            "modelSelection": {"modelName": model, "modelType": "public"}
        });
        handler.upsert_local_task(link);
    }
    handler.store = RuntimeWorkStore::new(handler.store.index_path().to_path_buf());

    for model in ["model-a", "model-b"] {
        let payload = json!({
            "taskId": model,
            "modelSelection": {"modelName": "unrelated-default", "modelType": "public"}
        });
        let response = handler
            .dispatch("runtime.tasks.get", payload.clone())
            .await
            .unwrap();
        assert_eq!(
            response["task"]["runtimeHandle"]["modelSelection"]["modelName"],
            model
        );
        let transcript = handler
            .dispatch("runtime.tasks.transcript", payload)
            .await
            .unwrap();
        assert_eq!(transcript["success"], true);
        let saved = handler.store.get_task_summary(model).unwrap();
        assert_eq!(saved.runtime_handle["modelSelection"]["modelName"], model);
    }
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
